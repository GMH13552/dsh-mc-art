#!/usr/bin/env node
/**
 * 客户端源码 → 可在这个进程里求值的**函数体**。
 *
 * 为什么不再用"字符串下标切片"：以前 icon-test / icon-render-test 用
 * `source.indexOf('const sub =')` 到 `source.indexOf('const CSS = [')` 切"绘制区"，
 * 于是 **CSS 数组必须排在绘制代码之后** —— 门禁在决定源码结构。client 拆成片段之后，
 * 这个约束逼着清单按反直觉顺序排（panel-ui 实测：顺序一换，切片为空，门禁 exit 2）。
 *
 * 现在的取法**与片段顺序无关**：客户端源码本身是"一段顶层声明 + 最后返回插件对象"
 * （`return { inject: [...], apply(ctx) { … } }`），去掉最后那个顶层 `return {`，
 * 剩下的全是顶层声明（函数、const、`let animTicks`…）。整段拿来当函数体即可，
 * 门禁在尾部自己 append 一个 return 暴露它要的名字 —— 不再假设"哪段在前、哪段在后"。
 *
 * 判据不变：代码仍然来自**真实源码本身**（调用方传入读到的文本，可带 `--fault` 的文本补丁），
 * 不是复制的实现。源码形状变了（找不到那个顶层 return）→ 明确抛错，
 * 绝不静默切出一个空区域（那就是"门禁看起来跑了、其实什么都没量"）。
 */
const RETURN_MARK = '\nreturn {'

function clientBodyOf(sourceText) {
  const at = sourceText.lastIndexOf(RETURN_MARK)
  if (at < 0) {
    throw new Error('客户端源码里找不到最后那个顶层 `return {...}`（插件对象）—— 源码形状变了，'
      + '这条门禁要跟着改（不要改回字符串下标切片，那会让门禁决定片段顺序）')
  }
  return sourceText.slice(0, at)
}

module.exports = { clientBodyOf }
