import { describe, it, expect } from 'vitest'
import {
  Permission,
  maskFromNames,
  maskToNames,
  resolvePermission,
  normalizeNodePath,
  isUnderPath,
  type PermissionNode
} from './permissions'

const P = Permission

describe('mask 转换', () => {
  it('从名称生成掩码', () => {
    expect(maskFromNames(['READ', 'WRITE'])).toBe(P.READ | P.WRITE)
    expect(maskFromNames(['UNKNOWN'])).toBe(0)
  })

  it('掩码转名称保持顺序', () => {
    expect(maskToNames(P.READ | P.DELETE)).toEqual(['READ', 'DELETE'])
  })
})

describe('normalizeNodePath', () => {
  it('规范化各种形式', () => {
    expect(normalizeNodePath('')).toBe('.')
    expect(normalizeNodePath('.')).toBe('.')
    expect(normalizeNodePath('./')).toBe('.')
    expect(normalizeNodePath('a/b/')).toBe('a/b')
    expect(normalizeNodePath('a\\b')).toBe('a/b')
    expect(normalizeNodePath('/a//b')).toBe('a/b')
  })
})

describe('resolvePermission 树形继承', () => {
  const nodes: PermissionNode[] = [
    { path: '.', inherit: false, mask: P.READ },
    { path: 'docs', inherit: true, mask: 0 },
    { path: 'docs/secret', inherit: false, mask: 0 },
    { path: 'writable', inherit: false, mask: P.READ | P.WRITE }
  ]

  it('根节点权限', () => {
    expect(resolvePermission(nodes, '.')).toBe(P.READ)
  })

  it('继承父级', () => {
    expect(resolvePermission(nodes, 'docs')).toBe(P.READ)
    expect(resolvePermission(nodes, 'docs/a.txt')).toBe(P.READ)
  })

  it('最近的显式覆盖生效', () => {
    expect(resolvePermission(nodes, 'docs/secret')).toBe(0)
    expect(resolvePermission(nodes, 'writable')).toBe(P.READ | P.WRITE)
  })

  it('未配置路径沿用父级', () => {
    expect(resolvePermission(nodes, 'unknown/x')).toBe(P.READ)
  })

  it('无任何配置返回 0', () => {
    expect(resolvePermission([], 'a')).toBe(0)
  })
})

describe('isUnderPath', () => {
  it('根路径包含一切', () => {
    expect(isUnderPath('a/b', '.')).toBe(true)
  })
  it('精确与子路径', () => {
    expect(isUnderPath('a/b', 'a')).toBe(true)
    expect(isUnderPath('ab', 'a')).toBe(false)
  })
})
