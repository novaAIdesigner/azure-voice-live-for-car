import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Settings, Gauge, Play, Square, ChevronDown, ChevronUp, Radio, Navigation } from 'lucide-react';
import { RealtimeClient } from './services/realtimeService';
import { carTools, executeCarTool } from './tools/carTools';
import { calculateEPASpeed, calculateBatteryConsumption, EPA_CYCLE_DURATION } from './utils/epaSimulator';

function App() {
  // Cookie utility functions
  const setCookie = (name, value, days = 365) => {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
  };

  const getCookie = (name) => {
    return document.cookie.split('; ').reduce((r, v) => {
      const parts = v.split('=');
      return parts[0] === name ? decodeURIComponent(parts[1]) : r;
    }, '');
  };

  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [logs, setLogs] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [sessionConfigJson, setSessionConfigJson] = useState(JSON.stringify({
    modalities: ["text", "audio"],
    instructions: "You are a helpful car assistant. Help the user with their vehicle.",
    voice: "en-US-Ava:DragonHDLatestNeural",
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    turn_detection: {
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500
    },
    input_audio_echo_cancellation: {
      type: "server_echo_cancellation"
    },
    input_audio_noise_reduction: {
      type: "azure_deep_noise_suppression"
    },
    input_audio_transcription: {
      model: "whisper-1"
    },
    tools: []
  }, null, 2));

  const [carStatus, setCarStatus] = useState({
    speed: 0,
    battery: 80,
    batteryRange: 245,
    temperature: 22,
    lights: 'off',
    windows: 'closed',
    music: 'off',
    radioStation: 'FM 101.5',
    radioPlaying: true,
    mediaType: 'radio',
    mediaVolume: 70,
    navigationActive: false,
    navigationDestination: 'Not set',
    navigationDistance: '—'
  });
  
  const [config, setConfig] = useState(() => {
    const savedEndpoint = getCookie('azure_endpoint');
    const savedApiKey = getCookie('azure_apiKey');
    return {
      endpoint: savedEndpoint || '',
      apiKey: savedApiKey || '',
      apiVersion: '2025-10-01',
      modelCategory: 'LLM Realtime',
      model: 'gpt-4o-realtime-preview',
      sessionConfig: JSON.parse(sessionConfigJson)
    };
  });

  const [metrics, setMetrics] = useState({
    tokens: {
      input_text: 0,
      input_audio: 0,
      output_text: 0,
      output_audio: 0,
      cached: 0,
      total: 0
    },
    latency: {
      values: [],
      min: 0,
      avg: 0,
      max: 0,
      p90: 0
    },
    turns: 0
  });

  const clientRef = useRef(null);

  // Save endpoint and apiKey to cookies when they change
  useEffect(() => {
    if (config.endpoint) {
      setCookie('azure_endpoint', config.endpoint);
    }
    if (config.apiKey) {
      setCookie('azure_apiKey', config.apiKey);
    }
  }, [config.endpoint, config.apiKey]);

  // EPA Cycle Simulation for BEV
  useEffect(() => {
    const epaInterval = setInterval(() => {
      setCarStatus(prev => {
        // EPA Federal Test Procedure: Total 1369 seconds (Cold Start 505s + Transient 864s)
        const time = Date.now() / 1000;
        const cyclePosition = time % EPA_CYCLE_DURATION; // Full EPA cycle
        
        // Get speed from EPA simulator
        const newSpeed = calculateEPASpeed(cyclePosition);
        
        // Calculate battery consumption
        const consumption = calculateBatteryConsumption(newSpeed);
        const newBattery = Math.max(0, prev.battery - consumption);
        const newRange = Math.round(newBattery * 3.1); // ~310 km at 100%

        return {
          ...prev,
          speed: newSpeed,
          battery: Math.round(newBattery * 100) / 100,
          batteryRange: newRange
        };
      });
    }, 500); // Update every 500ms

    return () => clearInterval(epaInterval);
  }, []);

  const addLog = (message, type = 'info') => {
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message, type }]);
  };

  const handleConnect = async () => {
    if (isConnected) {
      clientRef.current?.disconnect();
      setIsConnected(false);
      addLog('Disconnected');
      return;
    }

    if (!config.endpoint || !config.apiKey) {
      alert('Please provide Endpoint and API Key');
      return;
    }

    try {
      clientRef.current = new RealtimeClient(config);
      
      clientRef.current.on('open', () => {
        setIsConnected(true);
        addLog('Connected to Azure Voice Live');
      });

      clientRef.current.on('error', (err) => {
        addLog(`Error: ${err.message}`, 'error');
      });

      clientRef.current.on('message', async (event) => {
        if (event.type === 'response.function_call_arguments.done') {
           const { name, arguments: args } = event;
           addLog(`Tool Call: ${name}`, 'tool');
           const result = await executeCarTool(name, JSON.parse(args), setCarStatus);
           addLog(`Tool Result: ${JSON.stringify(result)}`, 'tool');
           clientRef.current.sendToolOutput(event.call_id, result);
        }
        
        if (event.type === 'response.done') {
            if (event.response && event.response.usage) {
              const usage = event.response.usage;
              const inputText = usage.input_tokens?.text || 0;
              const inputAudio = usage.input_tokens?.audio || 0;
              const outputText = usage.output_tokens?.text || 0;
              const outputAudio = usage.output_tokens?.audio || 0;
              const cached = usage.cache_creation_input_tokens || usage.cache_read_input_tokens || 0;
              
              setMetrics(prev => {
                const newLatencies = event.latency ? [...prev.latency.values, event.latency] : prev.latency.values;
                const sortedLatencies = [...newLatencies].sort((a, b) => a - b);
                const p90Index = Math.ceil(sortedLatencies.length * 0.9) - 1;
                
                return {
                  ...prev,
                  tokens: {
                    input_text: prev.tokens.input_text + inputText,
                    input_audio: prev.tokens.input_audio + inputAudio,
                    output_text: prev.tokens.output_text + outputText,
                    output_audio: prev.tokens.output_audio + outputAudio,
                    cached: prev.tokens.cached + cached,
                    total: prev.tokens.total + (usage.total_tokens || 0)
                  },
                  latency: {
                    values: newLatencies,
                    min: newLatencies.length > 0 ? Math.min(...newLatencies) : 0,
                    avg: newLatencies.length > 0 ? Math.round(newLatencies.reduce((a, b) => a + b, 0) / newLatencies.length) : 0,
                    max: newLatencies.length > 0 ? Math.max(...newLatencies) : 0,
                    p90: sortedLatencies.length > 0 ? sortedLatencies[p90Index] || 0 : 0
                  },
                  turns: prev.turns + 1
                };
              });
            }
        }
      });
      
      clientRef.current.setTools(carTools);
      await clientRef.current.connect();
    } catch (error) {
      addLog(`Connection failed: ${error.message}`, 'error');
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700 p-4">
        <div className="flex justify-between items-center max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold text-blue-400 flex items-center gap-2">
            <img src="https://devblogs.microsoft.com/foundry/wp-content/uploads/sites/89/2025/03/ai-foundry.png" alt="Azure AI" className="w-6 h-6 object-contain" />
            Azure Voice Live - Car Assistant
          </h1>
          <div className={`text-sm font-semibold ${isConnected ? 'text-green-400' : 'text-gray-400'}`}>
            {isConnected ? '● Connected' : '● Disconnected'}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="p-6 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          
          {/* LEFT SIDEBAR: Configuration */}
          <div className="lg:col-span-1 space-y-6">
            {/* Configuration Panel */}
            <div className="bg-gray-800 p-5 rounded-lg border border-gray-700">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Settings size={18} /> Configuration
              </h2>
              
              <div className="space-y-4">
                {/* Model Architecture */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1 font-semibold">Model Architecture</label>
                  <select 
                    value={config.modelCategory}
                    onChange={e => {
                      const category = e.target.value;
                      let defaultModel = '';
                      if (category === 'LLM Realtime') defaultModel = 'gpt-4o-realtime-preview';
                      else if (category === 'LLM+TTS') defaultModel = 'gpt-4o-realtime-preview';
                      else if (category === 'ASR+LLM+TTS') defaultModel = 'gpt-4o';
                      setConfig({...config, modelCategory: category, model: defaultModel});
                    }}
                    className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-xs text-white"
                  >
                    <option value="LLM Realtime">LLM Realtime</option>
                    <option value="LLM+TTS">LLM+TTS</option>
                    <option value="ASR+LLM+TTS">ASR+LLM+TTS</option>
                  </select>
                </div>

                {/* Model */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1 font-semibold">Model</label>
                  <select 
                    value={config.model}
                    onChange={e => setConfig({...config, model: e.target.value})}
                    className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-xs text-white"
                  >
                    {config.modelCategory === 'LLM Realtime' && (
                      <>
                        <option value="gpt-4o-realtime-preview">gpt-4o-realtime</option>
                        <option value="gpt-4o-mini-realtime-preview">gpt-4o-mini-realtime</option>
                      </>
                    )}
                    {config.modelCategory === 'LLM+TTS' && (
                      <>
                        <option value="gpt-4o-realtime-preview">gpt-4o-realtime</option>
                        <option value="gpt-4o-mini-realtime-preview">gpt-4o-mini-realtime</option>
                        <option value="phi-4-multimodal">phi-4 multimodal (5.6B for device)</option>
                      </>
                    )}
                    {config.modelCategory === 'ASR+LLM+TTS' && (
                      <>
                        <option value="gpt-4o">gpt-4o</option>
                        <option value="gpt-4.1">gpt-4.1</option>
                        <option value="gpt-4.5">gpt-4.5</option>
                        <option value="gpt-4o-mini">gpt-4o-mini</option>
                        <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                        <option value="gpt-4.1-nano">gpt-4.1-nano</option>
                        <option value="phi-4">phi-4 (14B)</option>
                      </>
                    )}
                  </select>
                </div>

                {/* Voice */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1 font-semibold">Voice</label>
                  <select 
                    value={config.sessionConfig.voice || ''}
                    onChange={e => setConfig({
                      ...config, 
                      sessionConfig: {...config.sessionConfig, voice: e.target.value}
                    })}
                    className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-xs text-white"
                  >
                    {config.modelCategory === 'LLM Realtime' ? (
                      <>
                        <option value="alloy">Alloy (OpenAI)</option>
                        <option value="echo">Echo (OpenAI)</option>
                        <option value="fable">Fable (OpenAI)</option>
                        <option value="nova">Nova (OpenAI)</option>
                        <option value="shimmer">Shimmer (OpenAI)</option>
                      </>
                    ) : (
                      <>
                        <option value="en-US-Ava:DragonHDLatestNeural">Ava (HD)</option>
                        <option value="en-US-Guy:DragonHDLatestNeural">Guy (HD)</option>
                        <option value="en-US-AmberNeural">Amber(Nerual)</option>
                        <option value="alloy">Alloy (OpenAI)</option>
                        <option value="echo">Echo (OpenAI)</option>
                        <option value="fable">Fable (OpenAI)</option>
                        <option value="nova">Nova (OpenAI)</option>
                        <option value="shimmer">Shimmer (OpenAI)</option>
                      </>
                    )}
                  </select>
                </div>

                {/* Endpoint */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1 font-semibold">Endpoint</label>
                  <input 
                    type="text" 
                    value={config.endpoint}
                    onChange={e => setConfig({...config, endpoint: e.target.value})}
                    className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-xs font-mono"
                    placeholder="wss://resource.services.ai.azure.com"
                  />
                </div>

                {/* API Key */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1 font-semibold">API Key</label>
                  <input 
                    type="password" 
                    value={config.apiKey}
                    onChange={e => setConfig({...config, apiKey: e.target.value})}
                    className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-xs"
                  />
                </div>

                {/* Advanced Settings */}
                <button 
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="w-full text-left text-xs text-gray-400 hover:text-gray-300 font-semibold flex justify-between items-center py-2 px-2 rounded hover:bg-gray-700"
                >
                  <span>Advanced Settings</span>
                  {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {showAdvanced && (
                  <div className="bg-gray-750 p-3 rounded border border-gray-600 space-y-3">
                    {/* Instructions */}
                    <div>
                      <label className="block text-xs text-gray-400 mb-1 font-semibold">Instructions</label>
                      <textarea 
                        value={config.sessionConfig.instructions}
                        onChange={e => {
                          const newSessionConfig = { ...config.sessionConfig, instructions: e.target.value };
                          setConfig({...config, sessionConfig: newSessionConfig});
                          setSessionConfigJson(JSON.stringify(newSessionConfig, null, 2));
                        }}
                        className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-xs h-20"
                        placeholder="System instructions..."
                      />
                    </div>

                    {/* Turn Detection */}
                    <div>
                      <label className="block text-xs text-gray-400 mb-1 font-semibold">VAD Threshold</label>
                      <input 
                        type="number"
                        step="0.1"
                        min="0"
                        max="1"
                        value={config.sessionConfig.turn_detection?.threshold || 0.5}
                        onChange={e => setConfig({
                          ...config,
                          sessionConfig: {
                            ...config.sessionConfig,
                            turn_detection: {
                              ...config.sessionConfig.turn_detection,
                              threshold: parseFloat(e.target.value)
                            }
                          }
                        })}
                        className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-xs"
                      />
                    </div>

                    {/* Full JSON Editor */}
                    <div>
                      <label className="block text-xs text-gray-400 mb-1 font-semibold">Session JSON</label>
                      <textarea 
                        value={sessionConfigJson}
                        onChange={e => {
                          setSessionConfigJson(e.target.value);
                          try {
                              const parsed = JSON.parse(e.target.value);
                              setConfig(prev => ({ ...prev, sessionConfig: parsed }));
                          } catch (err) {
                              // Invalid JSON
                          }
                        }}
                        className="w-full bg-gray-700 border border-gray-600 rounded p-2 text-xs font-mono h-32"
                      />
                    </div>
                  </div>
                )}

                {/* Connect Button */}
                <button 
                  onClick={handleConnect}
                  className={`w-full py-2 rounded font-semibold flex justify-center items-center gap-2 text-sm transition ${isConnected ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                >
                  {isConnected ? <><Square size={16} /> Disconnect</> : <><Play size={16} /> Connect</>}
                </button>
              </div>
            </div>

            {/* Car Status Panel */}
            <div className="bg-gray-800 p-5 rounded-lg border border-gray-700">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Gauge size={18} /> Vehicle Status
              </h2>
              
              <div className="space-y-3 text-sm">
                {/* Basic Status */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-gray-700 p-2 rounded">
                    <div className="text-gray-400 text-xs">Speed</div>
                    <div className="font-mono text-lg">{carStatus.speed}</div>
                    <div className="text-gray-500 text-xs">km/h</div>
                  </div>
                  <div className="bg-gray-700 p-2 rounded">
                    <div className="text-gray-400 text-xs">Battery</div>
                    <div className="font-mono text-lg">{carStatus.battery}%</div>
                    <div className="text-gray-500 text-xs">{carStatus.batteryRange} km</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-gray-700 p-2 rounded">
                    <div className="text-gray-400 text-xs">Lights</div>
                    <div className="font-mono capitalize text-sm">{carStatus.lights}</div>
                  </div>
                  <div className="bg-gray-700 p-2 rounded">
                    <div className="text-gray-400 text-xs">Windows</div>
                    <div className="font-mono capitalize text-sm">{carStatus.windows}</div>
                  </div>
                </div>

                {/* Media Player */}
                <div className="bg-gray-700 p-3 rounded border border-gray-600">
                  <div className="flex items-center gap-2 mb-2">
                    <Radio size={14} className="text-blue-400" />
                    <span className="text-xs text-gray-400 font-semibold">MEDIA</span>
                  </div>
                  
                  {/* Media Type Selection */}
                  <div className="mb-2">
                    <select 
                      value={carStatus.mediaType}
                      onChange={e => setCarStatus({...carStatus, mediaType: e.target.value})}
                      className="w-full bg-gray-600 border border-gray-500 rounded p-1 text-xs text-white"
                    >
                      <option value="radio">Radio</option>
                      <option value="music">Music</option>
                      <option value="podcast">Podcast</option>
                      <option value="audiobook">Audiobook</option>
                    </select>
                  </div>

                  {/* Current Media Info */}
                  <div className="text-xs font-mono mb-2 text-gray-300">
                    {carStatus.mediaType === 'radio' && carStatus.radioStation}
                    {carStatus.mediaType === 'music' && 'My Playlist'}
                    {carStatus.mediaType === 'podcast' && 'Tech Talk #127'}
                    {carStatus.mediaType === 'audiobook' && 'Digital Fortress'}
                  </div>

                  {/* Volume Control */}
                  <div className="mb-2">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs text-gray-400">Volume</span>
                      <span className="text-xs text-white font-semibold">{carStatus.mediaVolume}%</span>
                    </div>
                    <input 
                      type="range"
                      min="0"
                      max="100"
                      value={carStatus.mediaVolume}
                      onChange={e => setCarStatus({...carStatus, mediaVolume: parseInt(e.target.value)})}
                      className="w-full h-1 bg-gray-600 rounded-lg appearance-none slider"
                    />
                  </div>
                </div>

                {/* Navigator Status */}
                <div className="bg-gray-700 p-3 rounded border border-gray-600">
                  <div className="flex items-center gap-2 mb-2">
                    <Navigation size={14} className="text-green-400" />
                    <span className="text-xs text-gray-400 font-semibold">NAVIGATION</span>
                  </div>
                  <div className="text-xs text-gray-300 mb-2">
                    <div className="truncate">{carStatus.navigationDestination}</div>
                    <div className="text-gray-500">{carStatus.navigationDistance}</div>
                  </div>
                  <button 
                    onClick={() => setCarStatus({...carStatus, navigationActive: !carStatus.navigationActive})}
                    className={`w-full py-1 rounded text-xs ${carStatus.navigationActive ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-600 hover:bg-gray-500'}`}
                  >
                    {carStatus.navigationActive ? 'Active' : 'Inactive'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT PANEL: Chat/Voice Interface */}
          <div className="lg:col-span-3 flex flex-col gap-6">
            {/* Chat Panel - Flexible height */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 flex-1 flex flex-col">
              {/* Chat/Logs Area */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {logs.length === 0 && (
                  <div className="text-center text-gray-500 py-8">
                    <p className="text-sm">No messages yet</p>
                    <p className="text-xs mt-2">Connect and start speaking...</p>
                  </div>
                )}
                {logs.map((log, i) => (
                  <div key={i} className="text-xs">
                    <span className="text-gray-500">[{log.time}]</span>
                    <span className={`ml-2 ${log.type === 'error' ? 'text-red-400' : log.type === 'tool' ? 'text-yellow-400' : 'text-gray-300'}`}>
                      {log.type === 'tool' && '🔧 '}
                      {log.type === 'error' && '❌ '}
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>

              {/* Microphone Button */}
              <div className="border-t border-gray-700 p-4 flex justify-center">
                <button 
                  className={`p-6 rounded-full transition transform ${isRecording ? 'bg-red-500 scale-110 animate-pulse' : 'bg-blue-600 hover:bg-blue-700 hover:scale-105'}`}
                  onClick={() => setIsRecording(!isRecording)}
                  disabled={!isConnected}
                >
                  {isRecording ? <MicOff size={28} /> : <Mic size={28} />}
                </button>
              </div>
            </div>

            {/* Token Usage Panel - Below Chat */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-3">
              <div className="space-y-3">
                {/* Header with Export Button */}
                <div className="flex justify-between items-center mb-3">
                  <div className="text-sm font-semibold text-gray-300">Statistics</div>
                  <button
                    onClick={() => {
                      const textCache = metrics.tokens.input_text > 0 ? Math.round((metrics.tokens.cached / metrics.tokens.input_text) * 100) : 0;
                      const audioCache = metrics.tokens.input_audio > 0 ? Math.round((metrics.tokens.cached / metrics.tokens.input_audio) * 100) : 0;
                      const baseUrl = 'https://novaaidesigner.github.io/azure-voice-live-calculator/';
                      const params = new URLSearchParams({
                        dau: '1',
                        turns: metrics.turns.toString(),
                        inputAudio: metrics.tokens.input_audio.toString(),
                        outputAudio: metrics.tokens.output_audio.toString(),
                        inputText: metrics.tokens.input_text.toString(),
                        model: config.model,
                        avatar: 'none',
                        textCache: textCache.toString(),
                        audioCache: audioCache.toString(),
                        tts: 'neural'
                      });
                      window.open(`${baseUrl}?${params.toString()}`, '_blank');
                    }}
                    className="text-xs bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-white font-semibold transition"
                  >
                    Export to Calculator
                  </button>
                </div>

                {/* Compact Grid Layout */}
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {/* Token Usage Section */}
                  <div className="space-y-1">
                    <div className="text-gray-400 font-semibold text-xs mb-1">Tokens</div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">In Text</span>
                      <span className="text-blue-400 font-semibold">{metrics.tokens.input_text}</span>
                    </div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">In Audio</span>
                      <span className="text-cyan-400 font-semibold">{metrics.tokens.input_audio}</span>
                    </div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">Out Text</span>
                      <span className="text-green-400 font-semibold">{metrics.tokens.output_text}</span>
                    </div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">Out Audio</span>
                      <span className="text-purple-400 font-semibold">{metrics.tokens.output_audio}</span>
                    </div>
                  </div>

                  {/* Cache % Section */}
                  <div className="space-y-1">
                    <div className="text-gray-400 font-semibold text-xs mb-1">Cache %</div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">Text</span>
                      <span className="text-yellow-400 font-semibold">{metrics.tokens.input_text > 0 ? Math.round((metrics.tokens.cached / metrics.tokens.input_text) * 100) : 0}%</span>
                    </div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">Audio</span>
                      <span className="text-orange-400 font-semibold">{metrics.tokens.input_audio > 0 ? Math.round((metrics.tokens.cached / metrics.tokens.input_audio) * 100) : 0}%</span>
                    </div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">Turns</span>
                      <span className="text-blue-400 font-semibold">{metrics.turns}</span>
                    </div>
                  </div>

                  {/* Latency Section */}
                  <div className="space-y-1">
                    <div className="text-gray-400 font-semibold text-xs mb-1">Latency (ms)</div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">Min</span>
                      <span className="text-green-400 font-semibold">{metrics.latency.min}</span>
                    </div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">Avg</span>
                      <span className="text-blue-400 font-semibold">{metrics.latency.avg}</span>
                    </div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">Max</span>
                      <span className="text-red-400 font-semibold">{metrics.latency.max}</span>
                    </div>
                    <div className="bg-gray-700 p-1.5 rounded flex justify-between">
                      <span className="text-gray-400">P90</span>
                      <span className="text-orange-400 font-semibold">{metrics.latency.p90}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
