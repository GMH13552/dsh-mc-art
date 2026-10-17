    async function preload(dir, namespace) {
      const assets = dir + '/pack/assets/' + namespace
      const models = new Map()
      for (const entry of await listDir(assets + '/models/block')) {
        if (entry.type !== 'file' || !/\.json$/.test(entry.name)) continue
        const parsed = await readJson(assets + '/models/block/' + entry.name)
        if (parsed !== undefined) models.set('block/' + entry.name.replace(/\.json$/, ''), parsed)
      }
      const textures = new Map()
      // 项目自己的动画：键是**包内相对路径**（和 `textures` 的 value 同一个形态），
      // 因为 `quad.tex` / `textureIds` 里流的就是它。
      const animations = new Map()
      const animationNotes = new Map()
      for (const kind of ['block', 'blocks', 'entity', 'item']) {
        for (const entry of await listDir(assets + '/textures/' + kind)) {
          if (entry.type !== 'file' || !/\.png$/.test(entry.name)) continue
          // **存包内相对路径，不存绝对路径。** 这个值会一路流到 `quad.tex` → `textureIds`
          // → 客户端编辑器手里那个句柄，而客户端的底线是"只写项目自己的包"（拒盘符、拒前导
          // 斜杠）。存绝对路径的后果是**项目自己的每一张贴图在编辑器里都保存不了**，屏幕上
          // 还说"这条贴图句柄不是项目包里的相对路径"（用户实测；那句话对着一张明明就在
          // 项目包里的图说，读起来自相矛盾）。
          // 读：`textureFileOf()` 按项目根解析回绝对路径；写：`atlas.saveTexture` 同样解析。
          const relative = 'pack/assets/' + namespace + '/textures/' + kind + '/' + entry.name
          textures.set(namespace + ':' + kind + '/' + entry.name.replace(/\.png$/, ''), relative)
          // **项目自己的 `.mcmeta` 也要读**（以前只收 `.png`，`mcmeta` 一次都没提）：
          // 项目里的动图因此没有动画描述，3D 视图把整条竖条当成一张贴图贴上去 —— 糊；
          // 而游戏读 `.mcmeta`，动得好好的。
          const absolute = assets + '/textures/' + kind + '/' + entry.name
          const meta = await statOf(absolute + '.mcmeta')
          if (meta === undefined || meta.type !== 'file') continue
          const info = await projectAnimationOf(absolute)
          if (info.animation !== undefined) {
            animations.set(relative, info.animation)
          } else {
            animationNotes.set(relative, {
              state: 'unreadable',
              why: info.why,
              // 客户端原样显示这句：**有** `.mcmeta` 就绝不能说成"没有动画描述"。
              text: '这张贴图**有**动画描述文件，但我读不了它：' + relative + '.mcmeta —— ' + info.why,
            })
          }
        }
      }
      return { dir: dir, namespace: namespace, assets: assets, models: models, textures: textures,
        animations: animations, animationNotes: animationNotes }
    }

    async function readLang(assets) {
      const merged = {}
      for (const locale of ['en_us', 'zh_cn']) {
        const parsed = await readJson(assets + '/lang/' + locale + '.json')
        if (parsed === undefined || parsed === null || typeof parsed !== 'object') continue
        for (const key of Object.keys(parsed)) {
          const value = parsed[key]
          if (typeof value === 'string' && value.length > 0) merged[key] = value
        }
      }
      return merged
    }

    // 从参考目录现取回来的**贴图**句柄（`ref:` 给 textureUrlFor 用），按请求名索引。
    // 空表有两种原因：还没取过，或者刚换了参考目录签名（这时整表作废）。
    let vanillaTextureHandles = new Map()
    let vanillaTextureSignature = null

