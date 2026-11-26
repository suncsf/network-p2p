import fs from 'node:fs'
import path from 'node:path'

export class PathViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathViolationError'
  }
}

/**
 * 将用户提交的相对路径安全地解析到白名单根目录内。
 * 拒绝：绝对路径、包含 `..` 的穿越、NUL 字节、Windows 驱动器前缀。
 */
export function resolveSafePath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string') throw new PathViolationError('非法路径')
  if (relativePath.includes('\0')) throw new PathViolationError('路径包含非法字符')

  const normalizedRoot = path.resolve(root)
  const normalizedRel = relativePath.replace(/\\/g, '/')

  if (path.isAbsolute(normalizedRel) || /^[a-zA-Z]:/.test(normalizedRel)) {
    throw new PathViolationError('不允许使用绝对路径')
  }

  const segments = normalizedRel.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..')) {
    throw new PathViolationError('路径不得包含上级引用')
  }

  const resolved = path.resolve(normalizedRoot, ...segments)
  assertWithinRoot(normalizedRoot, resolved)
  return resolved
}

/** 校验 resolved 是否位于 root 内（前缀检查 + 分隔符边界） */
export function assertWithinRoot(root: string, resolved: string): void {
  const rel = path.relative(root, resolved)
  if (rel === '') return
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathViolationError('路径越出白名单根目录')
  }
}

/**
 * 对已存在的路径进行符号链接逃逸校验：使用 realpath 后再校验是否位于根目录内。
 * 返回规范化后的真实路径。
 */
export function resolveRealPathWithinRoot(root: string, resolved: string): string {
  assertWithinRoot(path.resolve(root), path.resolve(resolved))
  const realRoot = fs.realpathSync(root)
  const realTarget = fs.realpathSync(resolved)
  assertWithinRoot(realRoot, realTarget)
  return realTarget
}

/** 生成用于展示的相对路径（统一使用 /） */
export function toRelative(root: string, absolute: string): string {
  const rel = path.relative(root, absolute)
  return rel === '' ? '.' : rel.split(path.sep).join('/')
}
