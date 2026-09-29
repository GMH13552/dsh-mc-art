// Static checks for the zoom controls.
//
// This is a static check and says so: whether a wheel actually zooms the model
// instead of the page is something only a browser can answer, and the person who
// can see it is the user.  What CAN be pinned here is the mechanism -- React
// attaches onWheel as a PASSIVE listener, so preventDefault() inside it is a
// no-op and the page zooms.  The fix is a non-passive native listener on the
// element.  Remove that and this must fail.
const fs = require('fs')
const client = fs.readFileSync(process.env.MCART_CLIENT || require('path').join(__dirname, 'client.js'), 'utf8')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

check('不再依赖 React 的 onWheel（它对 wheel 是 passive 的）',
  client.indexOf('onWheel:') < 0)
check('在元素上自己挂 wheel 监听',
  client.indexOf("canvas.addEventListener('wheel', onWheel") >= 0)
check('而且是 passive: false，否则 preventDefault 无效',
  client.indexOf("{ passive: false }") >= 0)
check('卸载时要摘掉监听',
  client.indexOf("canvas.removeEventListener('wheel', onWheel)") >= 0)
check('滚轮会改 zoom 而不是滚页面',
  client.indexOf('event.preventDefault()') >= 0 && /onWheel[\s\S]{0,220}setZoom/.test(client))

check('有角标容器', client.indexOf("'mcart-zoom'") >= 0)
check('角标有三个按钮：放大 / 缩小 / 复位',
  client.indexOf("'放大'") >= 0 && client.indexOf("'缩小'") >= 0 && client.indexOf("'复位视角（旋转与缩放一起）'") >= 0)
check('放大缩小都走 zoomBy', (client.match(/zoomBy\(/g) || []).length >= 3,
  (client.match(/zoomBy\(/g) || []).length + ' 处')
check('zoomBy 有上下限，不会缩到 0 或无限大',
  /function zoomBy[\s\S]{0,200}Math\.max\(0\.35, Math\.min\(3/.test(client))
check('画布包在定位容器里，角标才能贴在上面',
  client.indexOf("'mcart-viewport'") >= 0 && /mcart-viewport[\s\S]{0,200}mcart-zoom/.test(client))
check('角标容器是 position:relative',
  client.indexOf('.mcart-viewport{position:relative') >= 0)
check('角标是 position:absolute',
  client.indexOf('.mcart-zoom{position:absolute') >= 0)

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
