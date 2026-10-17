    /**
     * 把项目模型解成元素。
     *
     * **项目自己的模型缺失就地停下**：把项目命名空间的名字交给原版 jar 是纯粹的浪费，
     * 也正是那份自相矛盾报告的来源（"项目包里没有这个文件" + "缺的原版母模型"）。只有
     * `minecraft:` / 别的命名空间的母模型才值得去参考目录现取。
     *
     * 模型齐了之后还有第二关：**贴图**。解不出来的面会被静默丢掉，所以这里把解不出来的
     * 引用收进 `unresolvedTextures`，并且先去参考目录现取一次原版贴图再重解。
     */
    async function projectElements(project, load, modelName) {
      const extra = new Map()
      let scan = chainGaps(load, modelName, extra)
      for (let round = 0; round < 4; round++) {
        if (scan.cycle === true) {
          return { elements: undefined, extra: extra, project: [], vanilla: [], cycle: true,
            fetchReason: 'parent-cycle', why: '', unresolvedTextures: [], textureWhy: '' }
        }
        if (scan.project.length > 0) {
          return { elements: undefined, extra: extra, project: scan.project, vanilla: [], cycle: false,
            fetchReason: '', why: '', unresolvedTextures: [], textureWhy: '' }
        }
        if (scan.vanilla.length === 0) break
        const fetched = await fetchVanillaModels(project, scan.vanilla.map((entry) => entry.name))
        if (fetched.models.size === 0) {
          return { elements: undefined, extra: extra, project: [], vanilla: scan.vanilla, cycle: false,
            fetchReason: fetched.reason === undefined ? '' : fetched.reason, why: fetched.why,
            unresolvedTextures: [], textureWhy: '' }
        }
        for (const pair of fetched.models.entries()) extra.set(pair[0], pair[1])
        scan = chainGaps(load, modelName, extra)
      }
      let unresolvedTextures = []
      // 三种"面取不到贴图"要分开收，因为**修法不同**（见 `blockDiagnostic`）：
      //   * `bareWords`：裸词（没有 `#`、没有 `:`、没有 `/`）而且**恰好是**这张模型
      //     `textures` 映射里的键 —— 作者写漏了 `#`，裸词被当成路径。
      //   * `danglingVariables`：`#变量` 在映射里根本找不到。
      //   * 其余（真·路径不存在）仍走 `unresolvedTextures`。
      let bareWords = []
      let danglingVariables = []
      const collect = (name, context) => {
        if (unresolvedTextures.indexOf(name) < 0) unresolvedTextures.push(name)
        const info = context === undefined || context === null ? {} : context
        const raw = String(info.raw === undefined ? '' : info.raw)
        const keys = Array.isArray(info.keys) ? info.keys : []
        const face = String(info.face === undefined ? '' : info.face)
        const bare = raw !== '' && raw.indexOf('#') < 0 && raw.indexOf(':') < 0 && raw.indexOf('/') < 0
        if (bare && keys.indexOf(raw) >= 0) {
          if (!bareWords.some((one) => one.raw === raw)) bareWords.push({ raw: raw, face: face, keys: keys.slice(0, 12) })
          return
        }
        if (raw.charAt(0) === '#' && keys.indexOf(raw.slice(1)) < 0) {
          if (!danglingVariables.some((one) => one.name === raw)) {
            danglingVariables.push({ name: raw, face: face })
          }
        }
      }
      // 链上每一步"从哪来"（项目包 / 现取 / 内置表 / 断掉）——报告里的"已试过的路"
      // 要按**实际走过哪条**说，而不是在什么都没缺时也写"（这次没走到）"。
      let trace = []
      let elements = elementsOf(load, modelName, extra, collect, trace)
      let textureWhy = ''
      if (unresolvedTextures.length > 0) {
        // 裸名按抽取器的惯例当成"先试项目、再退回 minecraft"，所以带上项目命名空间请求；
        // 已经是 `ns:path` 的原样请求。
        const wanted = unresolvedTextures.map((name) =>
          name.indexOf(':') >= 0 ? name : load.namespace + ':' + name)
        const fetched = await fetchVanillaTextures(project, wanted)
        textureWhy = fetched.why
        if (fetched.fetched > 0) {
          unresolvedTextures = []
          bareWords = []
          danglingVariables = []
          trace = []
          elements = elementsOf(load, modelName, extra, collect, trace)
        }
      }
      return { elements: elements, extra: extra, project: scan.project, vanilla: scan.vanilla,
        cycle: scan.cycle === true, fetchReason: '', why: '',
        unresolvedTextures: unresolvedTextures, bareWords: bareWords,
        danglingVariables: danglingVariables, textureWhy: textureWhy, trace: trace }
    }

    /**
     * blockstate 里出现的**所有**模型名，去重保序。
     *
     * 旧代码只读 `variants` 的第一个 key，于是 multipart 方块（原版墙/栅栏/玻璃板，用户工程里
     * 的 6 个墙 + fence/fence_gate/trapdoor/button/pressure_plate/ladder）一律回退成猜
     * `block/<id>` —— 而那个文件根本不存在（multipart 引用的是 `_post` / `_side` 那几件）。
     * `apply` 可能是对象也可能是数组；`when` 里写什么条件不用管，这里只收集被引用的模型。
     */
    function modelsInState(state) {
      const out = []
      const seen = {}
      const push = (value) => {
        if (value === undefined || value === null) return
        if (Array.isArray(value)) { for (const item of value) push(item); return }
        if (typeof value !== 'object') return
        const model = value.model
        if (typeof model === 'string' && model !== '' && seen[model] !== true) {
          seen[model] = true
          out.push(model)
        }
      }
      if (state === undefined || state === null || typeof state !== 'object') return out
      if (state.variants !== undefined && state.variants !== null && typeof state.variants === 'object') {
        for (const key of Object.keys(state.variants)) push(state.variants[key])
      }
      if (Array.isArray(state.multipart)) {
        for (const part of state.multipart) {
          if (part === null || typeof part !== 'object') continue
          push(part.apply)
        }
      }
      return out
    }

    /**
     * 一个方块引用好几个模型时，单块视图先画哪一个。规则可解释，不是"第一个"：
     *   0. 名字就是方块自己（`block/<id>`）—— "一个方块一个模型"的常规形状；
     *   1. `_post`（墙 / 栅栏 / 栅栏门的结构主件）；
     *   2. `_bottom`（门 / 活板门的下半，比上半更代表这个方块）；
     *   3. 名字以方块 id 开头（`<id>_stairs_inner` 这类）；
     *   4. `_side` / `_top` / `_inner` / `_outer` 这些附件。
     * 只在**项目包里真的存在**的模型里挑；一个都没有时返回第一个引用到的名字 ——
     * **不再猜 `block/<id>`**，报告要说的是"引用的这些模型不存在"。
     */
    function modelRank(id, name) {
      const base = String(name).replace(/^[^:]*:/, '').replace(/^block\//, '').replace(/\.json$/, '')
      if (base === id) return 0
      if (/_post$/.test(base)) return 1
      if (/_bottom$/.test(base)) return 2
      if (base.indexOf(id) === 0) return 3
      return 4
    }

    function chooseModel(load, id, models) {
      if (models.length === 0) return { model: 'block/' + id, guessed: true }
      const inPack = (name) => load.models.get(String(name).replace(/^[^:]*:/, '')) !== undefined
      let best = null
      for (const name of models) {
        if (!inPack(name)) continue
        const rank = modelRank(id, name)
        if (best === null || rank < best.rank) best = { model: name, rank: rank }
      }
      if (best !== null) return { model: best.model, guessed: false }
      return { model: models[0], guessed: false }
    }

    async function blockIds(load) {
      const out = []
      for (const entry of await listDir(load.assets + '/blockstates')) {
        if (entry.type !== 'file' || !/\.json$/.test(entry.name)) continue
        const id = entry.name.replace(/\.json$/, '')
        const state = await readJson(load.assets + '/blockstates/' + entry.name)
        const models = modelsInState(state)
        const chosen = chooseModel(load, id, models)
        out.push({ id: id, model: chosen.model, models: models, guessed: chosen.guessed })
      }
      return out
    }

