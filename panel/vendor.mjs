#!/usr/bin/env node
/**
 * 把「模式 + skill」复制进包里 —— **打包时生成，不进 git**。
 *
 * 为什么单独一个文件、而不是塞进 build.mjs：`prepare` 每次 `npm pack` / `npm publish`
 * （以及从 git 直接安装）都会跑它，而 build.mjs 生成 lib/ 需要 Python（strip_comments.py）。
 * 分成两半之后：没有 Python 的机器照样能打包（lib/ 是提交好的），
 * 要发布时再跑 build.mjs（prepublishOnly 里会跑，且带门禁）。
 *
 * mc-art 是独立仓库，本仓库里**不放它的副本**：这里只从本地克隆复制一份快照进包。
 */
import { vendored } from './build.mjs'

const pairs = vendored()
for (const [from, to] of pairs) process.stdout.write(`已复制 ${from} -> ${to}\n`)
