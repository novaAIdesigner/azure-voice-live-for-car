import React from 'react';
import { BarChart3 } from 'lucide-react';

export default function Statistics({ metrics }) {
  const textCacheRate = metrics.tokens.input_text > 0 
    ? ((metrics.tokens.cached_text / metrics.tokens.input_text) * 100).toFixed(1)
    : '0.0';
  
  const audioCacheRate = metrics.tokens.input_audio > 0 
    ? ((metrics.tokens.cached_audio / metrics.tokens.input_audio) * 100).toFixed(1)
    : '0.0';

  const exportToCalculator = () => {
    const baseUrl = 'https://novaaidesigner.github.io/azure-voice-live-calculator/';
    const params = new URLSearchParams({
      input_text_tokens: metrics.tokens.input_text,
      input_audio_tokens: metrics.tokens.input_audio,
      output_text_tokens: metrics.tokens.output_text,
      output_audio_tokens: metrics.tokens.output_audio,
      text_cache_rate: textCacheRate,
      audio_cache_rate: audioCacheRate
    });
    window.open(`${baseUrl}?${params.toString()}`, '_blank');
  };

  return (
    <div className="bg-gray-800 p-4 rounded-lg border border-gray-700">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <BarChart3 size={16} /> Statistics
        </h3>
        <button
          onClick={exportToCalculator}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs font-semibold"
        >
          Export to Calculator
        </button>
      </div>

      {/* Token Usage */}
      <div className="mb-4">
        <h4 className="text-xs text-gray-400 mb-2 font-semibold">Token Usage</h4>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Input Text</div>
            <div className="text-white font-semibold">{metrics.tokens.input_text}</div>
          </div>
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Input Audio</div>
            <div className="text-white font-semibold">{metrics.tokens.input_audio}</div>
          </div>
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Text Cache Rate</div>
            <div className="text-yellow-400 font-semibold">{textCacheRate}%</div>
          </div>
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Output Text</div>
            <div className="text-white font-semibold">{metrics.tokens.output_text}</div>
          </div>
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Output Audio</div>
            <div className="text-white font-semibold">{metrics.tokens.output_audio}</div>
          </div>
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Audio Cache Rate</div>
            <div className="text-orange-400 font-semibold">{audioCacheRate}%</div>
          </div>
        </div>
      </div>

      {/* Latency */}
      <div>
        <h4 className="text-xs text-gray-400 mb-2 font-semibold">Voice Input → Voice Output Latency (ms)</h4>
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Min</div>
            <div className="text-white font-semibold">{metrics.latency.min}</div>
          </div>
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Avg</div>
            <div className="text-white font-semibold">{metrics.latency.avg}</div>
          </div>
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">Max</div>
            <div className="text-white font-semibold">{metrics.latency.max}</div>
          </div>
          <div className="bg-gray-700 p-2 rounded">
            <div className="text-gray-400">P90</div>
            <div className="text-white font-semibold">{metrics.latency.p90}</div>
          </div>
        </div>
      </div>

      {/* Turn Count */}
      <div className="mt-3 text-xs text-gray-400">
        Total Turns: <span className="text-white font-semibold">{metrics.turns}</span>
      </div>
    </div>
  );
}
