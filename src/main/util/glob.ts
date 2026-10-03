const SPECIAL = /[.+^$()|\\]/g

/** Convert a glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) to a RegExp that matches a '/'-separated path. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/')
  let re = ''
  let braceDepth = 0
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      braceDepth++
      re += '(?:'
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--
      re += ')'
    } else if (c === ',' && braceDepth > 0) {
      re += '|'
    } else if (c === '[') {
      const end = g.indexOf(']', i + 1)
      if (end > i) {
        re += g.slice(i, end + 1)
        i = end
      } else {
        re += '\\['
      }
    } else {
      re += c.replace(SPECIAL, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

/** Patterns without a slash match the file name anywhere (like .gitignore); otherwise the whole relative path. */
export function matchGlob(glob: string, relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/')
  const re = globToRegExp(glob)
  if (!glob.includes('/')) {
    return re.test(rel.slice(rel.lastIndexOf('/') + 1))
  }
  return re.test(rel)
}
