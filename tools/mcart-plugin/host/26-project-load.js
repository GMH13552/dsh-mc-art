    async function preload(dir, namespace) {
      const assets = dir + '/pack/assets/' + namespace
      const models = new Map()
      // **文件在、但读不出来**的模型：以前 `readJson` 把 JSON 解析错误吞成 undefined，
      // 于是"模型文件写坏了"在报告里表现成"项目自己的模型文件缺失 → 补上它"（指向一个
      // 明明就在那里的文件）。现在按文件名记下真实原因，诊断里说"解析失败"而不是"缺失"。
      const unreadableModels = new Map()
      for (const entry of await listDir(assets + '/models/block')) {
        if (entry.type !== 'file' || !/\.json$/.test(entry.name)) continue
        const key = 'block/' + entry.name.replace(/\.json$/, '')
        const text = await readTextOf(assets + '/models/block/' + entry.name)
        if (text === undefined || text === null) {
          unreadableModels.set(key, { file: 'models/block/' + entry.name, why: '读不出文件内容' })
          continue
        }
        try {
          models.set(key, JSON.parse(String(text)))
        } catch (error) {
          unreadableModels.set(key, { file: 'models/block/' + entry.name, why: '不是合法 JSON：' + messageOf(error) })
        }
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
        animations: animations, animationNotes: animationNotes, unreadableModels: unreadableModels }
    }

    /**
     * 语言文件：读得出来就合并成一张名字表，读不出来就**把原因留着**。
     *
     * 以前这里用 `readJson`：它把 JSON 解析错误吞成 `undefined`，于是"写坏了的
     * `lang/*.json`"与"根本没有这个文件"走同一条路 —— 名字表是空的，报告里却只有一句
     * "方块名只能用原始 id"，没人知道是文件坏了。现在返回 `{ table, problems }`：
     * `problems` 里每个元素带**文件**和**真实原因**（`{ file: 'lang/en_us.json',
     * why: '不是合法 JSON：…' }`），诊断照着说"读不出来"，而不是说"缺失"。
     *
     * **缺文件只在"一个名字都没读出来"时才记进 problems**：那才是"方块名只能用原始 id"
     * 的真话。项目只写了 `en_us`、没有 `zh_cn` 时名字是好的，不能把正常状态报成读坏了；
     * 只有断掉的那个文件才拿得到真原因（缺失 / 不是合法 JSON / 读不出内容）。
     */
    async function readLang(assets) {
      const merged = {}
      const broken = []
      const missing = []
      for (const locale of ['en_us', 'zh_cn']) {
        const file = 'lang/' + locale + '.json'
        const full = assets + '/' + file
        const info = await statOf(full)
        if (info === undefined || info.type !== 'file') {
          missing.push({ file: file, why: '文件不存在（缺失，不是读坏了）' })
          continue
        }
        const text = await readTextOf(full)
        if (text === undefined || text === null) {
          broken.push({ file: file, why: '文件在，但读不出内容（权限或编码），不是缺失' })
          continue
        }
        let parsed
        try {
          parsed = JSON.parse(String(text))
        } catch (error) {
          broken.push({ file: file, why: '不是合法 JSON：' + messageOf(error) })
          continue
        }
        if (parsed === null || typeof parsed !== 'object') {
          broken.push({ file: file, why: '不是 JSON 对象（顶层应该是一张键值表）' })
          continue
        }
        for (const key of Object.keys(parsed)) {
          const value = parsed[key]
          if (typeof value === 'string' && value.length > 0) merged[key] = value
        }
      }
      const problems = broken.concat(Object.keys(merged).length === 0 ? missing : [])
      return { table: merged, problems: problems }
    }

    // 从参考目录现取回来的**贴图**句柄（`ref:` 给 textureUrlFor 用），按请求名索引。
    // 空表有两种原因：还没取过，或者刚换了参考目录签名（这时整表作废）。
    let vanillaTextureHandles = new Map()
    let vanillaTextureSignature = null

