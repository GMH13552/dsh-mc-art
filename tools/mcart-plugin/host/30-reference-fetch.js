    /**
     * 这个参考根里到底有没有**能读的东西** —— 用来把"目录/版本不对"和"这个母模型不在"
     * 分开。两种形态都算：版本 jar（含 mods/、versions/<v>/），或一棵已解包的
     * `assets/<命名空间>/…` 资源树（抽取器两条都支持）。只看 `.jar` 会把后者误判成
     * "参考目录没 jar"，而那棵树是完全合法的参考根。
     */
    async function referenceLooksReadable(directory) {
      const hasJar = async (dir) => {
        for (const entry of await listDir(dir)) {
          if (entry.type === 'file' && /\.jar$/i.test(entry.name)) return true
        }
        return false
      }
      const hasTree = async (dir) => {
        for (const entry of await listDir(dir + '/assets')) {
          if (entry.type !== 'directory') continue
          if (entry.name === 'indexes' || entry.name === 'objects' || entry.name === 'skins') continue
          return true
        }
        return false
      }
      if (await hasJar(directory)) return true
      if (await hasJar(directory + '/mods')) return true
      if (await hasTree(directory)) return true
      for (const version of await listDir(directory + '/versions')) {
        if (version.type !== 'directory') continue
        if (await hasJar(directory + '/versions/' + version.name)) return true
        if (await hasJar(directory + '/versions/' + version.name + '/mods')) return true
        if (await hasTree(directory + '/versions/' + version.name)) return true
      }
      return false
    }

    async function fetchVanillaModels(project, names) {
      const directory = await referenceDirectory(project)
      if (directory === '') {
        return { models: new Map(), reason: 'no-reference-directory',
          why: '这台机器上还没有设置参考目录（面板设置里指到 .minecraft/versions/<版本>，'
            + '或写进 mc-art.settings.json 的 reference.directory）' }
      }
      const signature = await refSignatureOf(directory)
      const want = []
      for (const name of names) {
        const cached = vanillaModels.get(signature + '|' + name)
        if (cached === undefined) want.push(name)
        else if (cached !== null) want.push(name)      // 命中缓存，下面照旧装进 out
      }
      if (want.length > 0) {
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) {
          return { models: new Map(), reason: 'extractor-failed', why: '找不到 ' + EXTRACT_SCRIPT }
        }
        const parsed = await runScanner(extractor, ['--root', directory, '--model', want.join(',')],
          120000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          const why = String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error)
          // 三种"取不到"要分开说，因为修法完全不同：目录/版本不对、这个母模型这个版本没有、
          // 脚本自己炸了。
          let reason = 'extractor-failed'
          if (why.indexOf('路径不存在') >= 0) reason = 'reference-jar-missing'
          else if (why.indexOf('一个模型都没取到') >= 0) {
            reason = (await referenceLooksReadable(directory)) ? 'vanilla-parent-missing' : 'reference-jar-missing'
          }
          return { models: new Map(), reason: reason, why: why }
        }
        for (const key of Object.keys(parsed.models || {})) {
          // 抽取器回的是 `minecraft:block/slab`，而调用方问的是 `block/slab` ——
          // 两个名字都存一份，不然查不到，表现成"取回来了却还是画不出来"。
          const bare = key.indexOf(':') >= 0 ? key.slice(key.indexOf(':') + 1) : key
          vanillaModels.set(signature + '|' + key, parsed.models[key])
          vanillaModels.set(signature + '|' + bare, parsed.models[key])
        }
        for (const name of want) {
          if (vanillaModels.get(signature + '|' + name) === undefined) vanillaModels.set(signature + '|' + name, null)
        }
      }
      const out = new Map()
      for (const name of names) {
        const hit = vanillaModels.get(signature + '|' + name)
        if (hit !== undefined && hit !== null) out.set(name, hit)
      }
      return { models: out, reason: '', why: '' }
    }

    /**
     * 从参考目录现取**贴图**（`--textures`），返回这次真正取到的名字。
     *
     * 为什么需要它：项目的模型经常直接引用原版贴图（`"texture": "block/ladder"`，裸名按
     * Minecraft 规则落在 `minecraft:` 上）。项目包里没有那个 PNG，于是 `resolveBlockModel`
     * 把那几个面静默丢掉、`quads` 变空 —— 用户看到的就是"取景框一片空白，屏幕上一个字都没有"
     * （实测 `mist_ladder`）。贴图和模型一样，参考目录的 jar 里就有，走同一条路取回来。
     */
    async function fetchVanillaTextures(project, names) {
      if (names.length === 0) return { fetched: 0, reason: '', why: '' }
      const directory = await referenceDirectory(project)
      if (directory === '') {
        return { fetched: 0, reason: 'no-reference-directory',
          why: '这台机器上还没有设置参考目录（原版贴图在 .minecraft/versions/<版本> 的 jar 里）' }
      }
      const signature = await refSignatureOf(directory)
      if (vanillaTextureSignature !== signature) {
        // 换了参考目录 / 换了版本：旧的句柄可能指向别的 jar，整表作废。
        vanillaTextureHandles = new Map()
        vanillaTextureSignature = signature
      }
      const want = names.filter((name) => vanillaTextureHandles.get(name) === undefined)
      if (want.length === 0) return { fetched: 0, reason: '', why: '' }
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) {
        return { fetched: 0, reason: 'extractor-failed', why: '找不到 ' + EXTRACT_SCRIPT }
      }
      const parsed = await runScanner(extractor, ['--root', directory, '--textures', want.join(',')],
        120000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        const why = String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error)
        let reason = 'extractor-failed'
        if (why.indexOf('路径不存在') >= 0) reason = 'reference-jar-missing'
        else if (why.indexOf('一个贴图都没取到') >= 0) {
          reason = (await referenceLooksReadable(directory)) ? 'textures-unresolved' : 'reference-jar-missing'
        }
        return { fetched: 0, reason: reason, why: why }
      }
      let fetched = 0
      for (const key of Object.keys(parsed.textures || {})) {
        const refKey = 'ref:' + key
        referenceTextures.set(refKey, 'data:image/png;base64,' + parsed.textures[key])
        const animation = (parsed.animations || {})[key]
        if (animation !== undefined && animation !== null) referenceAnimations.set(refKey, animation)
        // 抽取器按**请求名**回；再把真实落点（textureFiles 推出来的命名空间）也存一份，
        // 这样同一个 PNG 被别处带命名空间引用时也能命中。
        vanillaTextureHandles.set(key, refKey)
        const file = (parsed.textureFiles || {})[key]
        if (typeof file === 'string') {
          const parts = file.split('/')
          if (parts.length > 3 && parts[0] === 'assets') {
            vanillaTextureHandles.set(parts[1] + ':' + parts.slice(3).join('/').replace(/\.png$/, ''), refKey)
          }
        }
        fetched += 1
      }
      return { fetched: fetched, reason: '', why: '' }
    }

