import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  resolveSafePath,
  assertWithinRoot,
  resolveRealPathWithinRoot,
  PathViolationError,
  toRelative
} from './path-safety'

let root: string

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lattice-test-'))
  mkdirSync(path.join(root, 'sub'))
  writeFileSync(path.join(root, 'a.txt'), 'hi')
  // 指向根目录之外的符号链接
  try {
    symlinkSync(tmpdir(), path.join(root, 'escape'))
  } catch {
    /* 平台不支持则跳过 */
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveSafePath', () => {
  it('正常相对路径', () => {
    expect(resolveSafePath(root, 'sub/a.txt')).toBe(path.join(root, 'sub', 'a.txt'))
    expect(resolveSafePath(root, '')).toBe(root)
  })

  it('拒绝绝对路径', () => {
    expect(() => resolveSafePath(root, '/etc/passwd')).toThrow(PathViolationError)
    expect(() => resolveSafePath(root, 'C:\\Windows')).toThrow(PathViolationError)
  })

  it('拒绝穿越', () => {
    expect(() => resolveSafePath(root, '../outside')).toThrow(PathViolationError)
    expect(() => resolveSafePath(root, 'sub/../../outside')).toThrow(PathViolationError)
  })

  it('拒绝 NUL', () => {
    expect(() => resolveSafePath(root, 'a\0b')).toThrow(PathViolationError)
  })
})

describe('assertWithinRoot', () => {
  it('边界检查', () => {
    expect(() => assertWithinRoot(root, path.join(root, 'a'))).not.toThrow()
    expect(() => assertWithinRoot(root, root)).not.toThrow()
    expect(() => assertWithinRoot(root, path.dirname(root))).toThrow(PathViolationError)
  })
})

describe('resolveRealPathWithinRoot', () => {
  it('正常文件通过', () => {
    expect(resolveRealPathWithinRoot(root, path.join(root, 'a.txt'))).toBe(
      path.join(root, 'a.txt')
    )
  })

  it('符号链接逃逸被拒绝', () => {
    // 若创建成功才测试
    const link = path.join(root, 'escape')
    try {
      require('node:fs').lstatSync(link)
    } catch {
      return
    }
    expect(() => resolveRealPathWithinRoot(root, link)).toThrow()
  })
})

describe('toRelative', () => {
  it('生成相对路径', () => {
    expect(toRelative(root, root)).toBe('.')
    expect(toRelative(root, path.join(root, 'a.txt'))).toBe('a.txt')
  })
})
