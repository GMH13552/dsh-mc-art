    // ---- items: the 2D inventory side -------------------------------------
    //
    // A block is drawn from its blockstate; an item is drawn from its ITEM model,
    // and the pack gives two different things depending on which it is:
    //   `iso`  the chain has `elements` (a block item) -- the inventory icon is
    //          the block drawn isometrically, with `display.gui` (vanilla:
    //          rotation [30,225,0], scale 0.625) and the GUI's OWN lighting.
    //   `flat` no elements, `layer0..N` sprites stacked, lit from the front.
    // The extractor hands back `--item ns:name`; everything below only turns
    // that into what the browser needs (ref: handles, quads, data URLs).
    async function referenceLoadItem(root, project, namespace, item, source) {
      const fromProject = source === 'project'
      const key = 'item:' + (fromProject ? 'project:' : '') + namespace + ':' + item
      const resolved = await itemRoots(project, source)
      if (resolved.error !== undefined) return { error: resolved.error }
      const signature = await rootsSignature(resolved.roots)
      const cached = referenceBlocks.get(key)
      if (cached !== undefined && cached.signature === signature) return cached
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) {
        return { error: '找不到 ' + EXTRACT_SCRIPT + '（从项目目录往上找了 5 层都没有）。' }
      }
      const parsed = await runScanner(extractor,
        rootArgs(resolved.roots).concat(['--item', namespace + ':' + item]),
        120000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || (parsed.error !== undefined && parsed.error !== null)) {
        return { error: String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error) }
      }
      const entry = {
        signature: signature, namespace: namespace, item: item, source: source,
        name: parsed.name || item, version: parsed.version,
        shape: parsed.shape, light: parsed.light, display: parsed.display || null,
        form: parsed.form, family: parsed.family, formLabel: parsed.formLabel,
        layers: parsed.layers || [], frames: parsed.frames || [],
        framesTruncated: parsed.framesTruncated === true,
        modelRefs: parsed.modelRefs || [], modelRotations: parsed.modelRotations || [],
        rotation: parsed.variantRotation === undefined ? null : parsed.variantRotation,
        parsed: parsed,
      }
      referenceBlocks.set(key, entry)
      return entry
    }

    // Which roots an item query reads.
    //
    // A project's own pack ships `models/item/…` but NOT the vanilla parents
    // those models inherit: `{"parent": "block/cube_all"}` is an UNQUALIFIED
    // reference, which in the game means `minecraft:block/cube_all`.  So the
    // pack alone leaves every chain incomplete -- every one of our own block
    // items came back `shape: none`, i.e. an item with no icon, which is what
    // "看不到我们自己做出来的资源的物品形式" was.
    //
    // Two roots fix it, ordered: the pack first (its own file wins), the game
    // reference second (it completes the vanilla half).  The extractor has
    // taken several `--root`s for block lists all along; the item paths were the
    // two that dropped all but the first.
    async function itemRoots(project, source) {
      const reference = await referenceDirectory(project)
      if (source === 'project') {
        const roots = [project.dir + '/pack']
        if (reference !== '') roots.push(reference)
        return { roots: roots, reference: reference }
      }
      if (reference === '') {
        return { error: '还没有设置参考目录，取不到原版或模组的物品。在设置里指定 .minecraft 或版本目录。' }
      }
      return { roots: [reference], reference: reference }
    }

    /** `--root <一> --root <二>`：交原始字符串，转义留给 runScanner（唯一转义点）。 */
    function rootArgs(roots) {
      const out = []
      for (const one of roots) out.push('--root', one)
      return out
    }

    async function rootsSignature(roots) {
      const parts = []
      for (const one of roots) parts.push(await refSignatureOf(one))
      return parts.join('|')
    }

    // A texture reference as the host's `ref:` handle.  The extractor may hand
    // back a bare `item/clock_00` (an unqualified reference resolves in the
    // item's own namespace), and `virtualLoad` keys its handles by namespace, so
    // the same qualification has to happen here or the picture is blank.
    // ref handle -> the real file in the project's own pack.  Filled while an
    // item is extracted (from the extractor's `textureFiles`), read by
    // `atlas.saveTexture`.  A block's texture ids are already paths; an item's
    // are handles, and without this the pen refused every item texture.
    const editablePaths = new Map()

    function itemHandle(namespace, reference) {
      const text = String(reference === undefined || reference === null ? '' : reference)
      return 'ref:' + (text.indexOf(':') >= 0 ? text : namespace + ':' + text)
    }

    /**
     * 一个取不到图标的物品在**页**里占的那一格。
     *
     * 为什么不能塞 `undefined`（实测 0.2.3）：宿主的运行时会拒收含 `undefined` 的返回值
     * （`cloneJson`；`run.js` 的 `jsonProblem` 是同一条判据）—— 于是**一页 40 格里有一格
     * 取不到，整页 40 格一起失败**，屏幕上什么都没有，用户以为面板坏了。
     * 正确的答案是"只空这一格、并说清为什么"，所以这里给一个**显式**的缺失标记：
     * `missing: true` + `error`/`reason` 文案，其余字段都补成合法值，保证可无损 JSON。
     */
    function missingItemIcon(namespace, item, reason) {
      const text = String(reason === undefined || reason === null ? '' : reason)
      return {
        namespace: namespace,
        item: item,
        name: item,
        shape: 'none',
        error: text,
        missing: true,
        reason: text,
        light: null, display: null, form: null, family: null, formLabel: null,
        named: false, layers: [], frames: [], framesTruncated: false,
        quads: [], textureIds: [], textures: {}, animations: {},
        missingModels: [], modelPath: '',
      }
    }

    /** 抽取器给的这个条目本身能不能画：`null` = 能；否则返回一句给人看的原因。 */
    function itemEntryProblem(namespace, item, entry) {
      if (entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry)) {
        return '取不到这个物品的图标：抽取器没有返回它的数据（' + namespace + ':' + item + '）'
      }
      if (typeof entry.error === 'string' && entry.error !== '') return entry.error
      if (typeof entry.item !== 'string' || entry.item === '') {
        return '取不到这个物品的图标：抽取器没认出 ' + namespace + ':' + item
      }
      return null
    }

