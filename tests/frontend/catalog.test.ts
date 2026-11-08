import assert from 'node:assert/strict'
import { test } from 'node:test'
import { duplicateFilePaths, directoryRevisions, remoteIsNewer } from '../../src/lib/libraryCatalog.ts'
import { isFavorite, rememberRepo, toggleFavorite } from '../../src/lib/repoMemory.ts'
import { groupTaskBatches } from '../../src/lib/taskBatches.ts'
import type { DownloadTask, LocalFile, RepoFile } from '../../src/types.ts'

function task(patch: Partial<DownloadTask>): DownloadTask {
  return {
    taskId: patch.taskId ?? 't',
    source: patch.source ?? 'huggingface',
    repoId: patch.repoId ?? 'org/model',
    remotePath: patch.remotePath ?? 'a.gguf',
    fileName: patch.fileName ?? 'a.gguf',
    savePath: patch.savePath ?? 'D:/Models/org/model/a.gguf',
    tempPath: patch.tempPath ?? 'D:/Models/org/model/a.gguf.part',
    totalSize: patch.totalSize ?? 10,
    downloaded: patch.downloaded ?? 10,
    status: patch.status ?? 'completed',
    speed: 0,
    retries: 0,
    revision: patch.revision ?? 'main',
    addedAt: patch.addedAt ?? 1,
    sha256: patch.sha256,
  }
}

test('tasks from one repository stay in one batch', () => {
  const batches = groupTaskBatches([
    task({ taskId: '1', fileName: 'a', addedAt: 1 }),
    task({ taskId: '2', repoId: 'other/model', fileName: 'b', addedAt: 3 }),
    task({ taskId: '3', fileName: 'c', addedAt: 2, revision: 'main' }),
  ])
  assert.equal(batches.length, 2)
  assert.equal(batches[0].repoId, 'other/model')
  assert.deepEqual(
    batches[1].tasks.map((item) => item.taskId),
    ['1', '3'],
  )
})

test('the same relative path in two roots is a duplicate', () => {
  const file = (path: string, rootDir: string): LocalFile => ({
    path,
    name: 'a.gguf',
    size: 4,
    modifiedAt: 1,
    kind: 'weight',
    rootDir,
  })
  const duplicates = duplicateFilePaths([
    file('D:/Models/org/a.gguf', 'D:/Models'),
    file('E:/Archive/org/a.gguf', 'E:/Archive'),
    file('D:/Models/org/b.gguf', 'D:/Models'),
  ])
  assert.equal(duplicates.has('d:/models/org/a.gguf'), true)
  assert.equal(duplicates.has('e:/archive/org/a.gguf'), true)
  assert.equal(duplicates.has('d:/models/org/b.gguf'), false)
})

test('a directory shows one revision when its tasks agree', () => {
  const revisions = directoryRevisions([
    task({ savePath: 'D:/Models/org/model/a.gguf', revision: 'main' }),
    task({ savePath: 'D:/Models/org/model/b.gguf', revision: 'main', remotePath: 'b.gguf' }),
  ])
  assert.equal(revisions.get('d:/models/org/model'), 'main')
})

test('remote size or checksum marks a completed file as newer', () => {
  const remote: RepoFile = { path: 'a.gguf', name: 'a.gguf', size: 20, kind: 'weight', sha256: 'bb' }
  assert.equal(remoteIsNewer(remote, task({ totalSize: 10, sha256: 'aa' })), true)
  assert.equal(remoteIsNewer(remote, task({ totalSize: 20, sha256: 'bb' })), false)
  assert.equal(remoteIsNewer(remote, task({ status: 'queued', totalSize: 10 })), false)
})

test('recent repos stay unique and favorites toggle', () => {
  const first = rememberRepo([], { source: 'huggingface', repoId: 'org/model' }, 1)
  const second = rememberRepo(first, { source: 'huggingface', repoId: 'org/model', revision: 'dev' }, 2)
  assert.equal(second.length, 1)
  assert.equal(second[0].revision, 'dev')
  const favorites = toggleFavorite([], { source: 'modelscope', repoId: 'org/model' }, 3)
  assert.equal(isFavorite(favorites, { source: 'modelscope', repoId: 'org/model' }), true)
  assert.equal(toggleFavorite(favorites, favorites[0]).length, 0)
})
