// Static checks for the block list: every block must be REACHABLE, not merely
// present somewhere behind a ceiling.
//
// First cut drew `choices.slice(0, 72)` -- 407 minecraft blocks and 1403 AoA3
// blocks both showed 72.  Second cut drew 240 with a search box, and the user
// rightly said "只显示前面240算什么".  Now: categories + paging.
const fs = require('fs')
const client = fs.readFileSync(process.env.MCART_CLIENT || require('path').join(__dirname, 'client.js'), 'utf8')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

// --- no ceiling ------------------------------------------------------------
check('没有把列表截在 72', client.indexOf('slice(0, 72)') < 0)
check('没有把列表截在 240', client.indexOf('VISIBLE_SLOTS') < 0 && client.indexOf('slice(0, 240)') < 0)
check('一页多少个是一个常量', client.indexOf('const PAGE_SIZE = 20') >= 0)

// --- paging covers everything ---------------------------------------------
check('页数按总数算出来', /Math\.ceil\(total \/ PAGE_SIZE\)/.test(client))
check('这一页是切片而不是截断',
  /list\.slice\(\(shownPage - 1\) \* PAGE_SIZE, shownPage \* PAGE_SIZE\)/.test(client))
check('页码会被夹在 1..pages 之间', /Math\.min\(Math\.max\(1, pickPage\), pages\)/.test(client))
check('有上一页/下一页',
  client.indexOf("key: 'pager'") >= 0
  && client.indexOf("'\u2039 \u4e0a\u4e00\u9875'") >= 0 && client.indexOf("'\u4e0b\u4e00\u9875 \u203a'") >= 0)
check('写出了 第 x / y 页 共 n 个',
  client.indexOf("'\u7b2c ' + view.page + ' / ' + view.pages + ' \u9875 \u00b7 \u5171 ' + view.total + ' \u4e2a'") >= 0)
check('可以直接跳页', /type: 'number', min: 1, max: view\.pages/.test(client))

// --- categories come from data, not from me -------------------------------
// Structural: `if (false) { ... 'groups' ... }` left the string in the file and
// a presence check passed.  Both rows are pushed under a real condition.
check('有分类行（大类）',
  /if \(groupKeys\.length > 0\) \{/.test(client) && client.indexOf("key: 'groups'") >= 0)
check('有分类行（形状）',
  /if \(familyKeys\.length > 1\) \{/.test(client) && client.indexOf("key: 'families'") >= 0)
check('大类与形状都来自条目自己的字段',
  client.indexOf('function groupOfItem(item)') >= 0 && client.indexOf('function familyOfItem(item)') >= 0)
check('分类计数与点进去看到的同源', /function countsBy\(keyOf, within\)/.test(client))
check('形状行会跟着大类收窄',
  /familyOfItem,\s*\n\s*pickGroup === '' \? null : \(item\) => groupOfItem\(item\) === pickGroup/.test(client))
check('搜索时不再显示分类（否则数字对不上）',
  /const needle = String\(filter\)\.trim\(\)\.toLowerCase\(\)\s*\n\s*if \(needle === ''\) \{/.test(client))

// --- a shape change must not leave the old page behind --------------------
check('换来源时把分类与页码一起复位',
  /function resetPick\(\) \{/.test(client) && (client.match(/resetPick\(\)/g) || []).length >= 3)
check('改搜索词时回到第 1 页',
  /onChange: \(event\) => \{ setFilter\(event\.target\.value\); setPickPage\(1\) \}/.test(client))

// --- icons follow the page, not the whole namespace ------------------------
// Opening a different asset leaves source/filter/page unchanged, so the asset
// identity has to be in the effect's key or the new asset never gets icons.
check('图标 effect 把"哪个资产"算进依赖',
  /voxel\.source \+ '\|' \+ voxel\.kind/.test(client))
check('图标只为这一页取', /for \(const item of choiceView\(\)\.list\)/.test(client))
check('图标请求有问过了的记忆，否则会无限重问',
  /iconTried\[item\.name\] === true/.test(client))
check('图标按批取', client.indexOf('ICON_BATCH') >= 0 && /missing\.slice\(0, ICON_BATCH\)/.test(client))
check('取图标前先把这一批标记为已问',
  /for \(const name of batch\) iconTried\[name\] = true/.test(client))

// --- the picker's number ---------------------------------------------------
check('下拉显示的是方块数而不是贴图数',
  client.indexOf("' \u4e2a\u65b9\u5757\uff09'") >= 0 && client.indexOf('item.blocks') >= 0)
check('下拉不再用贴图数', client.indexOf("item.count + ' \u5f20'") < 0)

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
