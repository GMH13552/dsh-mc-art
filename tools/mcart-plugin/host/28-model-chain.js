    function texturePath(load, reference) {
      let name = String(reference === undefined ? '' : reference)
      let namespace = load.namespace
      const colon = name.indexOf(':')
      if (colon >= 0) { namespace = name.slice(0, colon); name = name.slice(colon + 1) }
      const key = namespace + ':' + name
      const own = load.textures.get(key)
      if (own !== undefined) return own
      const other = preloads.get(namespace)
      if (other !== undefined) {
        const hit = other.textures.get(key)
        if (hit !== undefined) return hit
      }
      // 项目模型直接引用原版贴图（`"texture": "block/ladder"`，裸名按 Minecraft 规则
      // 是 `minecraft:block/ladder`）时，项目包里没有这个文件 —— 但参考目录的 jar 里有，
      // `fetchVanillaTextures()` 已经把 PNG 取回来存成 `ref:` 句柄。查不到就返回 undefined，
      // 由 `elementsOf` 把它记进"解不出来的贴图"，绝不再静默丢面。
      const fetched = vanillaTextureHandles.get(key)
      return fetched === undefined ? undefined : fetched
    }

    function elementsOf(load, modelName, extra, unresolved, trace) {
      let key = modelName
      const colon = key.indexOf(':')
      if (colon >= 0) key = key.slice(colon + 1)
      const model = load.models.get(key) || (extra === undefined ? undefined : extra.get(key))
      if (model === undefined) return undefined
      return resolveBlockModel(model, (id) => {
        let parentKey = id
        const c = parentKey.indexOf(':')
        if (c >= 0) parentKey = parentKey.slice(c + 1)
        const own = load.models.get(parentKey)
        if (own !== undefined) return own
        if (extra === undefined) return undefined
        // 现取回来的那份表按 `minecraft:block/x` 存，查的时候带不带命名空间都要能命中。
        return extra.get(id) || extra.get(parentKey) || extra.get('minecraft:' + parentKey)
      }, (reference, context) => {
        const tex = texturePath(load, reference)
        // `resolveBlockModel` 在贴图解不出来时会 `continue` 掉那个面（`quads` 于是可能是空的）。
        // 把解不出来的引用收上来（连面的上下文），报告才能说清"是哪几个面、用的是谁"，
        // 以及分清"写漏了 #" / "#变量找不到" / "路径真的不存在"这三种。
        if (tex === undefined && typeof unresolved === 'function') unresolved(String(reference), context)
        return tex
      }, trace)
    }

    // 现取回来的原版模型，按"参考目录签名 + 名字"缓存。签名变了（换了版本目录）自然失效。
    const vanillaModels = new Map()

    /**
     * 项目模型链上"断掉的地方"，**按命名空间分类**。
     *
     * 这是那份自相矛盾报告的根因：旧 `missingParents()` 把"根模型（项目自己的模型文件）
     * 缺失"也记成"缺的原版母模型"，然后拿一个**项目命名空间**的名字去原版 jar 里现取 ——
     * 当然取不到，于是报告的上一行说"项目包里没有这个文件"、下一行说"缺的原版母模型"，
     * 两行互相打架，还把用户引向去改 parent。
     *
     * 判据是命名空间，不是名字长得像不像：
     *   * 根模型名来自 blockstate 的 `model` 字段 —— 不带命名空间时按 Minecraft 的规则
     *     落在**当前包**的命名空间里，所以裸名 = 项目自己的模型；`minecraft:` 才是原版。
     *   * `parent` 不带命名空间时按 Minecraft 的规则落在 `minecraft:` 上，所以裸 parent = 原版；
     *     带别的命名空间 = 那个命名空间的东西（同样不在项目包里，去参考目录现取）。
     *
     * 返回值里的两个数组分得清清楚楚，报告就不许再把 project 的写成"缺的原版母模型"。
     */
    function chainGaps(load, modelName, extra) {
      const project = []
      const vanilla = []
      const seen = {}
      let cycle = false
      let key = String(modelName === undefined ? '' : modelName)
      let nameNamespace = load.namespace
      const colon = key.indexOf(':')
      if (colon >= 0) { nameNamespace = key.slice(0, colon); key = key.slice(colon + 1) }
      const own = (namespace) => namespace === '' || namespace === load.namespace
      for (let depth = 0; depth < 24; depth++) {
        const fromExtra = extra === undefined ? undefined
          : (extra.get(key) !== undefined ? extra.get(key) : extra.get('minecraft:' + key))
        const model = load.models.get(key) || fromExtra
        if (model === undefined) {
          if (key === '') break
          const isOwn = own(nameNamespace)
          const entry = { name: isOwn ? key : nameNamespace + ':' + key, bare: key,
            namespace: isOwn ? load.namespace : nameNamespace, kind: isOwn ? 'project' : 'vanilla' }
          if (isOwn) project.push(entry); else vanilla.push(entry)
          break
        }
        const parent = model.parent
        if (typeof parent !== 'string' || parent === '') break
        if (seen[parent] === true) { cycle = true; break }
        seen[parent] = true
        let parentNamespace = 'minecraft'
        let bare = parent
        const at = parent.indexOf(':')
        if (at >= 0) { parentNamespace = parent.slice(0, at); bare = parent.slice(at + 1) }
        if (load.models.get(bare) !== undefined) { key = bare; nameNamespace = parentNamespace; continue }
        if (extra !== undefined && (extra.get(parent) !== undefined || extra.get(bare) !== undefined)) {
          key = bare; nameNamespace = parentNamespace; continue
        }
        // 内置表里有就还用内置的（省一次进程）。
        if (VANILLA_PARENTS[parent] !== undefined || VANILLA_PARENTS[bare] !== undefined) break
        const isOwn = own(parentNamespace)
        const entry = { name: parent, bare: bare, namespace: parentNamespace,
          kind: isOwn ? 'project' : 'vanilla' }
        if (isOwn) project.push(entry); else vanilla.push(entry)
        break
      }
      return { project: project, vanilla: vanilla, cycle: cycle }
    }

    /**
     * 一条 missing 条目"人能直接照做"的路径（§2.4 硬要求 2）。
     *
     * 项目自己的模型：补 `<项目>/pack/assets/<ns>/models/block/<名字>.json`。
     * 原版母模型：补不了（原版在 jar 里），能照做的是把参考目录指对 / 指对版本。
     */
    function fixPathOf(load, entry, directory) {
      if (entry.kind === 'project') {
        // 项目方块模型住在 `models/block/`；`block/x` 和裸 `x` 都归到那儿。
        const rest = entry.bare.replace(/^block\//, '')
        return 'pack/assets/' + load.namespace + '/models/block/' + rest + '.json'
      }
      const where = directory === ''
        ? '把参考目录指到 .minecraft/versions/<版本>（面板设置里那一栏）'
        : directory + ' 里的 <版本>.jar'
      return where + ' → assets/' + (entry.namespace || 'minecraft') + '/models/' + entry.bare + '.json'
    }

