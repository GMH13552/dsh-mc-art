    async function build(root) {
      const staged = []
      const nextPreloads = new Map()
      const nextLangs = new Map()
      for (const entry of await listDir(root)) {
        if (entry.type !== 'directory' || entry.name.charAt(0) === '.') continue
        const dir = root + '/' + entry.name
        const atlas = await readJson(dir + '/mc-art.atlas.json')
        const assets = await listDir(dir + '/pack/assets')
        const namespaces = []
        for (const candidate of assets) if (candidate.type === 'directory') namespaces.push(candidate.name)
        if (namespaces.length === 0 && atlas === undefined) continue
        const namespace = (atlas && typeof atlas.namespace === 'string' && namespaces.indexOf(atlas.namespace) >= 0)
          ? atlas.namespace : namespaces[0]
        if (namespace === undefined) continue
        const load = await preload(dir, namespace)
        const lang = await readLang(load.assets)
        // 语言文件"读不出来"的真原因要跟到诊断手里：`load` 就是 `preloads` 里缓存的那一份，
        // 报告（`blockDiagnostic`）从它身上取 `langProblems`，`langs` 仍然只是一张名字表。
        load.langProblems = lang.problems
        nextPreloads.set(namespace, load)
        nextLangs.set(namespace, lang.table)
        staged.push({ entry: entry.name, dir: dir, atlas: atlas, namespace: namespace, load: load })
      }
      preloads = nextPreloads
      langs = nextLangs

      const projects = []
      for (const item of staged) {
        const namespace = item.namespace
        const atlas = item.atlas
        const blocks = []
        for (const block of await blockIds(item.load)) {
          blocks.push({ id: block.id, title: labelFor(namespace, 'block', block.id) })
        }
        projects.push({
          id: item.entry, title: labelFor(namespace, 'project', item.entry),
          namespace: namespace, root: root, dir: item.dir, blocks: blocks,
          entities: (atlas && atlas.entities ? atlas.entities : []).map((e) => ({ id: e.id, title: labelFor(namespace, 'entity', e.id) })),
          biomes: (atlas && atlas.biomes ? atlas.biomes : []).map((b) => ({ id: b.id, title: labelFor(namespace, 'biome', b.id) })),
          structures: (atlas && atlas.structures ? atlas.structures : []).map((s) => ({ id: s.id, title: labelFor(namespace, 'structure', s.id) })),
        })
      }
      return { projects: projects, preloads: nextPreloads, langs: nextLangs }
    }

    async function indexOf(root) {
      const signature = await signatureOf(root)
      const cached = indexCache.get(root)
      if (cached !== undefined && cached.signature === signature) {
        preloads = cached.preloads
        langs = cached.langs
        return { projects: cached.projects, cached: true }
      }
      const built = await build(root)
      indexCache.set(root, { signature: signature, projects: built.projects, preloads: built.preloads, langs: built.langs })
      return { projects: built.projects, cached: false }
    }

    async function projectFor(root, projectId) {
      if (root === '' || projectId === '') return undefined
      const index = await indexOf(root)
      return index.projects.filter((item) => item.id === projectId)[0]
    }

    async function looksLikeProject(dir) {
      if ((await statOf(dir + '/mc-art.atlas.json')) !== undefined) return true
      const assets = await listDir(dir + '/pack/assets')
      return assets.length > 0
    }

    // Where does a reference root actually keep its assets?  Not in one shape.
    // For 1.12.2 the vanilla textures live INSIDE the version jar -- that
    // assets/index.json has zero entries under minecraft/textures/block/ -- and
    // Forge keeps every mod in versions/<version>/mods/<name>.jar.  So "scan the
    // reference" means "read jars", and tools/mcart_scan_refs.py is the single
    // implementation of that.  This side only locates it and calls it.
    const SCAN_SCRIPT = 'tools/mcart_scan_refs.py'
    const EXTRACT_SCRIPT = 'tools/mcart_extract_block.py'
    // A whole namespace of blocks is ~190 KB of JSON, and 72 icons ~40 KB.
    const REFERENCE_MAX_BYTES = 8 * 1024 * 1024
    // Both tools live in the same repository, so they share one upward search
    // instead of two that could disagree about where the repo root is.
    const toolPaths = new Map()

    /** 去掉结尾的路径分隔符（`C:/x/` → `C:/x`）。 */
    function trimTrailing(value) {
      let at = String(value === undefined || value === null ? '' : value)
      while (at.length > 1 && (at.charAt(at.length - 1) === '/' || at.charAt(at.length - 1) === BACKSLASH)) {
        at = at.slice(0, at.length - 1)
      }
      return at
    }

    /**
     * 把 `start` 归一成**绝对路径**。
     *
     * 这是"45 个方块 28 个画不出来"的根因（Lead 实测并复现）：`findTool` 原来把结果按
     * `relative` 一个键缓存，而 `at + '/' + relative` 里的 `at` 直接来自调用方。
     * `atlas.env` 不带 root 时用 `'.'`（面板每次开面板都会问一遍），于是缓存里存下的是
     * `./tools/mcart_extract_block.py`；之后 `runScanner` 用 `cwd = project.dir` 起进程，
     * Python 去找 `<工程目录>/tools/mcart_extract_block.py` —— 当然没有。
     * **返回相对路径是根因**：不管缓存怎么改，这里都不许把相对路径交出去。
     */
    function absoluteOf(value) {
      const raw = String(value === undefined || value === null ? '' : value)
      if (raw === '') return ''
      if (raw.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(raw) || raw.slice(0, 2) === '\\\\') return raw
      const cwd = (typeof process !== 'undefined' && process !== null && typeof process.cwd === 'function')
        ? process.cwd() : ''
      if (cwd === '') return raw
      return trimTrailing(cwd.split(BACKSLASH).join('/')) + '/' + raw
    }

    async function findTool(start, relative) {
      const base = absoluteOf(trimTrailing(start))
      // 缓存键带上归一后的 start：同一个 relative 在不同工程目录下的答案可以不同。
      const cacheKey = relative + '|' + base
      if (toolPaths.has(cacheKey)) return toolPaths.get(cacheKey)
      let found = null
      // 1) **随包的那份先查**：`<包>/python/` 是唯一保证"别人的机器上也有"的那一份，
      //    而且它和宿主是**同一个版本**。项目目录里残留一份旧脚本时，不该让它盖住这份
      //    （宿主和抽取器对不上，是比"找不到"更难查的毛病）。
      for (const candidate of skillToolCandidates(relative)) {
        const full = absoluteOf(trimTrailing(candidate))
        const info = await statOf(full)
        if (info !== undefined && info.type === 'file') { found = full; break }
      }
      // 2) 兜底：从归一后的 start 往上找（工程恰好在本仓库里、或有人真的把 tools/ 放在
      //    工程里）。返回的路径一定以 base 开头，所以一定是绝对的。
      if (found === null) {
        let at = base
        for (let depth = 0; depth < 5 && at !== ''; depth++) {
          const info = await statOf(at + '/' + relative)
          if (info !== undefined && info.type === 'file') { found = at + '/' + relative; break }
          at = parentOf(at) || ''
        }
      }
      toolPaths.set(cacheKey, found)
      return found
    }

