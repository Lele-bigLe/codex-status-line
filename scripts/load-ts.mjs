import { readFileSync } from 'node:fs'
import ts from 'typescript'

// 使用项目已有编译器在内存中加载源码，让检查不依赖 Node 的实验性 TS 支持。
export function loadTs(file) {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  })
  const code = outputText.replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, name) => {
    const dependency = new URL(name.endsWith('.ts') ? name : `${name}.ts`, file)
    return `from ${quote}${loadTs(dependency)}${quote}`
  })
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}
