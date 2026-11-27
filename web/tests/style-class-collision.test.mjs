import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = new URL('..', import.meta.url).pathname
const stylesDir = join(root, 'src/styles')
const srcDir = join(root, 'src')

/**
 * 允许被多个组件共用的全局类（设计系统）。
 *
 * 这些是刻意共享的控件与排版类：按钮、卡片、表单、栅格、日志行……
 * 其余的全局类都属于某个具体组件，别的组件不能拿去用——
 * 组件的 scoped 规则只能覆盖它显式声明的属性，
 * 剩下的（position、width、height、border、background）会照单全收，
 * 结果就是元素被拽到别处、或者被套上别人的外壳。
 */
const SHARED = new Set([
  'btn', 'btn-block', 'btn-dark', 'btn-ghost', 'btn-primary', 'btn-sm',
  'card', 'card-pad', 'count', 'empty-desc', 'empty-title', 'field-label',
  'grid', 'guide-hint', 'head-actions', 'hint', 'input', 'input-sm',
  'k', 'kv', 'link', 'log-card', 'log-line', 'log-msg', 'log-time', 'mono', 'page', 'result-box',
  'section', 'section-aside', 'section-head', 'section-index', 'section-left',
  'section-title', 'segment', 'segment-item', 'shell', 'split', 'strip-scroll',
  'switch', 'text-danger', 'v', 'workbench', 'workbench-aside', 'workbench-main',
])

/** 递归列出所有 .vue 文件。 */
function vueFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...vueFiles(path))
    else if (path.endsWith('.vue')) out.push(path)
  }
  return out
}

/** 取出 SFC 的模板块：第一个 <template> 到最后一个 </template>。 */
function templateOf(source) {
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  return start >= 0 && end > start ? source.slice(start, end) : ''
}

/** 模板里用到的静态类名。 */
function classesIn(template) {
  const used = new Set()
  for (const match of template.matchAll(/class="([^"{]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) used.add(name)
  }
  return used
}

const globalCss = ['tokens.css', 'minimal.css', 'components.css']
  .map(file => readFileSync(join(stylesDir, file), 'utf8'))
  .join('\n')
const globalClasses = new Set(globalCss.match(/(?<![\w-])\.([a-zA-Z][\w-]*)/g)?.map(name => name.slice(1)) ?? [])

test('a global class that belongs to one component is not borrowed by another', () => {
  const usage = new Map()
  for (const file of vueFiles(srcDir)) {
    for (const name of classesIn(templateOf(readFileSync(file, 'utf8')))) {
      if (!globalClasses.has(name)) continue
      if (!usage.has(name)) usage.set(name, [])
      usage.get(name).push(file.replace(root, ''))
    }
  }
  const borrowed = [...usage]
    .filter(([name, files]) => files.length > 1 && !SHARED.has(name))
    .map(([name, files]) => `.${name} 被 ${files.join('、')} 同时使用`)
  assert.deepEqual(borrowed, [], `全局类名撞车：\n${borrowed.join('\n')}`)
})

test('the audit panel uses its own prefixed class instead of global widgets', () => {
  const source = readFileSync(join(srcDir, 'components/MifareAuditPanel.vue'), 'utf8')
  // .check 是墨水屏缩略图的对勾徽章，.opt 是画板工具条的大按钮。
  assert.ok(!/class="check"/.test(source), '面板不能使用全局的 .check 类')
  assert.ok(!/class="opt"/.test(source), '面板不能使用全局的 .opt 类')
  assert.ok(/\.audit-opt\s*\{/.test(source), '面板自己的复选框行要用 .audit-opt')
})
