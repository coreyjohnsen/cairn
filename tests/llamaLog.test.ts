import { describe, expect, it } from 'vitest'
import { parseLlamaMemory } from '../src/shared/llamaLog'

describe('reading where the engine put the model', () => {
  it('reads a model that went entirely to the GPU (CUDA, current format)', () => {
    const log = [
      'load_tensors: offloading 32 repeating layers to GPU',
      'load_tensors: offloading output layer to GPU',
      'load_tensors: offloaded 33/33 layers to GPU',
      'load_tensors:        CUDA0 model buffer size =  4095.05 MiB',
      'load_tensors:   CPU_Mapped model buffer size =   281.81 MiB',
      'llama_context: n_ctx = 8192',
      'llama_kv_cache_unified:      CUDA0 KV buffer size =  1024.00 MiB',
      'llama_context:      CUDA0 compute buffer size =   296.00 MiB',
      'llama_context:  CUDA_Host compute buffer size =    17.01 MiB',
      'llama_context:        CPU  output buffer size =     0.49 MiB'
    ]
    expect(parseLlamaMemory(log)).toEqual({ gpuModelMB: 4095, gpuCacheMB: 1024, gpuComputeMB: 296, cpuModelMB: 282, cpuCacheMB: 0, cpuComputeMB: 17, layersOnGpu: 33, layersTotal: 33 })
  })

  it('reads a split model on Vulkan with some of the cache in RAM', () => {
    const log = [
      'load_tensors: offloaded 20/49 layers to GPU',
      'load_tensors:      Vulkan0 model buffer size =  5120.40 MiB',
      'load_tensors:   CPU_Mapped model buffer size =  7400.10 MiB',
      'llama_kv_cache_unified:      Vulkan0 KV buffer size =   400.00 MiB',
      'llama_kv_cache_unified:        CPU KV buffer size =   624.00 MiB',
      'llama_context:    Vulkan0 compute buffer size =   312.00 MiB',
      'llama_context:        CPU compute buffer size =    40.50 MiB'
    ]
    expect(parseLlamaMemory(log)).toEqual({ gpuModelMB: 5120, gpuCacheMB: 400, gpuComputeMB: 312, cpuModelMB: 7400, cpuCacheMB: 624, cpuComputeMB: 41, layersOnGpu: 20, layersTotal: 49 })
  })

  it('adds up both caches of a sliding-window model', () => {
    const log = [
      'llama_kv_cache_unified_iswa: creating non-SWA KV cache, size = 16384 cells',
      'llama_kv_cache_unified:      ROCm0 KV buffer size =   256.00 MiB',
      'llama_kv_cache_unified_iswa: creating     SWA KV cache, size = 1536 cells',
      'llama_kv_cache_unified:      ROCm0 KV buffer size =    96.00 MiB'
    ]
    expect(parseLlamaMemory(log)?.gpuCacheMB).toBe(352)
  })

  it('reads the older wording', () => {
    const log = [
      'llm_load_tensors: offloaded 33/33 layers to GPU',
      'llm_load_tensors:        CUDA0 buffer size =  4095.05 MiB',
      'llm_load_tensors:        CPU buffer size =   281.81 MiB',
      'llama_kv_cache_init:      CUDA0 KV buffer size =   512.00 MiB',
      'llama_new_context_with_model:      CUDA0 compute buffer size =   258.50 MiB'
    ]
    expect(parseLlamaMemory(log)).toMatchObject({ gpuModelMB: 4095, cpuModelMB: 282, gpuCacheMB: 512, gpuComputeMB: 259, layersOnGpu: 33 })
  })

  it('says nothing when the engine reported nothing', () => {
    expect(parseLlamaMemory([])).toBeNull()
    expect(parseLlamaMemory(['$ llama-server -m model.gguf', 'main: server is listening on http://127.0.0.1:8080'])).toBeNull()
  })
})
