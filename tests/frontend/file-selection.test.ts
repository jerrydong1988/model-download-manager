import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessDisk } from '../../src/lib/diskSpace.ts'
import {
  defaultSelectedPaths,
  pathsForQuant,
  pathsForShard,
  quantChoices,
  quantOf,
  shardChoices,
  shardOf,
} from '../../src/lib/fileSelection.ts'
import { parseRepoLink } from '../../src/lib/repoLink.ts'
import { verifyPresentation } from '../../src/lib/verifyLabel.ts'
import type { DownloadTask, RepoFile } from '../../src/types.ts'

function file(path: string, kind: RepoFile['kind'], size = 10): RepoFile {
  const name = path.split('/').pop() ?? path
  return { path, name, size, kind }
}

test('quant and shard names parse without swallowing model names', () => {
  assert.equal(quantOf('Qwen2.5-7B-Instruct-Q4_K_M.gguf'), 'Q4_K_M')
  assert.equal(quantOf('mmproj-model-f16.gguf'), 'F16')
  assert.equal(quantOf('model.safetensors'), null)
  const shard = shardOf('weights/model-00001-of-00004.safetensors')
  assert.equal(shard?.label, 'model.safetensors')
  assert.equal(shard?.index, 1)
  assert.equal(shard?.total, 4)
  assert.equal(shardOf('model.safetensors'), null)
})

test('default selection keeps one quant plus the companion projector', () => {
  const files = [
    file('model-Q4_K_M.gguf', 'weight', 40),
    file('model-Q8_0.gguf', 'weight', 80),
    file('model-F16.gguf', 'weight', 160),
    file('mmproj-model-f16.gguf', 'mmproj', 8),
    file('imatrix.gguf', 'imatrix', 1),
    file('config.json', 'config', 1),
  ]
  assert.deepEqual(defaultSelectedPaths(files), [
    'model-Q4_K_M.gguf',
    'mmproj-model-f16.gguf',
  ])
  assert.deepEqual(pathsForQuant(files, 'Q8_0'), ['model-Q8_0.gguf', 'mmproj-model-f16.gguf'])
  assert.equal(quantChoices(files)[0]?.id, 'Q4_K_M')
})

test('a single weight set still selects every weight and projector', () => {
  const files = [
    file('model-00001-of-00002.safetensors', 'weight', 5),
    file('model-00002-of-00002.safetensors', 'weight', 5),
    file('mmproj.safetensors', 'mmproj', 2),
  ]
  assert.deepEqual(defaultSelectedPaths(files), files.map((item) => item.path))
  assert.equal(shardChoices(files).length, 1)
  assert.deepEqual(pathsForShard(files, shardChoices(files)[0].id), [
    'model-00001-of-00002.safetensors',
    'model-00002-of-00002.safetensors',
  ])
})

test('quant folders isolate generic shards and projectors; explicit filename wins', () => {
  const files = [
    file('Q4_K_M/weights/model-00001-of-00002.gguf', 'weight'),
    file('Q4_K_M/weights/model-00002-of-00002.gguf', 'weight'),
    file('Q4_K_M/mmproj.gguf', 'mmproj'),
    file('Q8_0/weights/model-00001-of-00002.gguf', 'weight'),
    file('Q8_0/weights/model-00002-of-00002.gguf', 'weight'),
    file('Q8_0/mmproj.gguf', 'mmproj'),
    file('Q4_K_M/model-Q8_0.gguf', 'weight'),
  ]
  assert.deepEqual(quantChoices(files).map(({ id, fileCount }) => [id, fileCount]), [
    ['Q4_K_M', 2], ['Q8_0', 3],
  ])
  assert.deepEqual(defaultSelectedPaths(files), files.slice(0, 3).map(f => f.path))
  assert.deepEqual(pathsForQuant(files, 'Q8_0').sort(), files.slice(3).map(f => f.path).sort())
})

test('quant shards stay together inside the chosen quant', () => {
  const files = [
    file('model-Q4_K_M-00001-of-00002.gguf', 'weight', 4),
    file('model-Q4_K_M-00002-of-00002.gguf', 'weight', 4),
    file('model-Q8_0.gguf', 'weight', 20),
  ]
  assert.deepEqual(defaultSelectedPaths(files), [
    'model-Q4_K_M-00001-of-00002.gguf',
    'model-Q4_K_M-00002-of-00002.gguf',
  ])
})

test('repo links open the repo and preselect a file', () => {
  assert.deepEqual(
    parseRepoLink('https://huggingface.co/Qwen/Qwen2.5-7B-Instruct/blob/main/model-Q4_K_M.gguf?download=true'),
    {
      source: 'huggingface',
      repoId: 'Qwen/Qwen2.5-7B-Instruct',
      revision: 'main',
      filePath: 'model-Q4_K_M.gguf',
    },
  )
  assert.deepEqual(parseRepoLink('https://hf-mirror.com/org/name/tree/dev'), {
    source: 'huggingface',
    repoId: 'org/name',
    revision: 'dev',
  })
  assert.deepEqual(
    parseRepoLink('https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct/file/view/master/config.json'),
    {
      source: 'modelscope',
      repoId: 'Qwen/Qwen2.5-0.5B-Instruct',
      revision: 'master',
      filePath: 'config.json',
    },
  )
  assert.equal(parseRepoLink('https://example.com/org/name'), null)
  assert.equal(parseRepoLink('Qwen/Qwen2.5-7B-Instruct'), null)
})

test('disk preflight reports a shortfall and a low segmented reserve', () => {
  const short = assessDisk({
    freeBytes: 100,
    volume: 'D:',
    selectedBytes: 250,
    unknownSizeCount: 0,
    connectionsPerFile: 4,
  })
  assert.equal(short.level, 'short')
  assert.equal(short.shortfallBytes, 150)

  const low = assessDisk({
    freeBytes: 2 * 1024 * 1024 * 1024,
    volume: 'D:',
    selectedBytes: 1.5 * 1024 * 1024 * 1024,
    unknownSizeCount: 1,
    connectionsPerFile: 4,
  })
  assert.equal(low.level, 'low')
  assert.equal(low.unknownSizeCount, 1)

  const single = assessDisk({
    freeBytes: 2 * 1024 * 1024 * 1024,
    volume: 'C:',
    selectedBytes: 1.5 * 1024 * 1024 * 1024,
    unknownSizeCount: 0,
    connectionsPerFile: 1,
  })
  assert.equal(single.level, 'ok')
})

test('library verify label follows the newest task for that path', () => {
  const task = {
    taskId: 't',
    source: 'huggingface',
    repoId: 'org/model',
    remotePath: 'a.bin',
    fileName: 'a.bin',
    savePath: 'D:\\Models\\org\\model\\a.bin',
    tempPath: 'D:\\Models\\org\\model\\a.bin.part',
    totalSize: 3,
    downloaded: 3,
    status: 'completed',
    speed: 0,
    retries: 0,
    revision: 'main',
    addedAt: 2,
    verifyStatus: 'verified',
  } satisfies DownloadTask
  assert.equal(verifyPresentation('D:/Models/org/model/a.bin', [task]).label, '已校验')
  assert.equal(verifyPresentation('D:/Models/missing.bin', []).label, '无校验和')
  assert.equal(
    verifyPresentation(task.savePath, [{ ...task, verifyStatus: 'mismatch', status: 'error' }]).label,
    '不一致',
  )
})
