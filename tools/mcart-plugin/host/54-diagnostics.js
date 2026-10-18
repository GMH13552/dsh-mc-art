    /**
     * "画不出来"时给客户端 / 人的那份东西（BRIEF §2.4 的冻结契约）。
     *
     * 结构化部分（reason / missing / tried / referenceDirectory）由客户端渲染；人读文本
     * 满足四条硬要求：① `kind:'project'` 的绝不许写成"缺的原版母模型"；② 每条都给能直接
     * 照做的路径；③ 没设参考目录时 reason 必须是 no-reference-directory 并说清去哪设；
     * ④ 只在屏幕上、可复制、≤20 行、同样的输入给同样的文本（人不被刷屏，客户端好去重）。
     */
    /** 一条贴图引用的缺失条目：`kind` / `name` / `fixPath`，和模型那条同一个形状。 */
    function textureMissingOf(load, name, directory) {
      const colon = name.indexOf(':')
      const explicit = colon >= 0
      const namespace = explicit ? name.slice(0, colon) : load.namespace
      const path = explicit ? name.slice(colon + 1) : name
      const kind = explicit && namespace !== load.namespace ? 'vanilla' : 'project'
      const where = directory === ''
        ? '把参考目录指到 .minecraft/versions/<版本>（面板设置里那一栏）'
        : directory + ' 里的 <版本>.jar'
      return {
        kind: kind,
        name: explicit ? name : load.namespace + ':' + name,
        fixPath: kind === 'project'
          ? 'pack/assets/' + load.namespace + '/textures/' + path + '.png'
          : where + ' → assets/' + namespace + '/textures/' + path + '.png',
      }
    }

    function blockDiagnostic(load, namespace, id, found, built, directory) {
      // 语言文件里的名字读不出来（坏 JSON / 读不出 / 一个表都没有）—— 名字为什么是原始 id
      // 的答案。以前 `readLang` 把解析错误吞成空表，报告里只剩"名字是 id"，没人知道是文件坏了。
      const langProblems = load === undefined || !Array.isArray(load.langProblems) ? [] : load.langProblems
      const project = Array.isArray(built.project) ? built.project : []
      const vanilla = Array.isArray(built.vanilla) ? built.vanilla : []
      const textures = Array.isArray(built.unresolvedTextures) ? built.unresolvedTextures : []
      // 写漏 `#` 的裸词 / 找不到的 `#变量`：这两种**不是**"缺贴图"，修法完全不同。
      const bareWords = Array.isArray(built.bareWords) ? built.bareWords : []
      const dangling = Array.isArray(built.danglingVariables) ? built.danglingVariables : []
      const missing = project.concat(vanilla).map((entry) => ({
        kind: entry.kind === 'project' ? 'project' : 'vanilla',
        name: String(entry.name),
        fixPath: fixPathOf(load, entry, directory),
      })).concat(textures.map((name) => textureMissingOf(load, name, directory)))
      let reason = 'unknown'
      if (built.cycle === true) reason = 'parent-cycle'
      else if (project.length > 0) reason = 'project-model-missing'
      else if (typeof built.fetchReason === 'string' && built.fetchReason !== '') reason = built.fetchReason
      else if (vanilla.length > 0) reason = directory === '' ? 'no-reference-directory' : 'vanilla-parent-missing'
      // 模型链是完整的、面也都解出来了，只是**贴图**解不出来（原版贴图不在项目包里）
      // 或者整条链一个面都没有 —— 这两种以前会返回一个"成功但 quads 是空"的对象，
      // 屏幕上什么都不说，取景框一片空白。
      // 写漏 `#` **先于** "缺贴图" 报：它的修法是把裸词改成 `#裸词`，不是去补 PNG
      // （用户实测：`"texture": "stone"` 被当成路径 `<命名空间>:textures/stone.png`，
      //  整块丢掉；报告原来说"贴图解不出来"，人就去翻贴图目录了）。
      else if (bareWords.length > 0) reason = 'texture-missing-hash'
      else if (dangling.length > 0) reason = 'texture-variable-unresolved'
      else if (textures.length > 0) {
        // 解不出来的**全是项目自己的**贴图 → 那就是项目包里缺文件（`textures-unresolved`），
        // 跟"没设参考目录"没关系；只有掺了原版/别的命名空间的，才可能是参考目录那条路的问题。
        // （以前只要没设参考目录就一律说 no-reference-directory，把项目里少一张 PNG 也说成设置问题。）
        const onlyProject = textures.every((name) => textureMissingOf(load, name, directory).kind === 'project')
        reason = directory === '' && !onlyProject ? 'no-reference-directory' : 'textures-unresolved'
      }
      else if (built.noQuads === true) reason = 'no-quads'
      // **整条链一个 `elements` 都没有**：以前这里掉进 `unknown`（`noQuads` 只在
      // `elements !== undefined` 时才置位），而 `unknown` 等于没有诊断。
      else if (built.noElements === true) reason = 'no-geometry'
      // 结构化字段一律非 undefined：宿主的运行时会拒收含 undefined 的返回值。
      const allowed = { 'project-model-missing': 1, 'vanilla-parent-missing': 1,
        'no-reference-directory': 1, 'reference-jar-missing': 1, 'extractor-failed': 1,
        'parent-cycle': 1, 'textures-unresolved': 1, 'no-quads': 1, 'no-geometry': 1,
        'texture-missing-hash': 1, 'texture-variable-unresolved': 1, 'unknown': 1 }
      if (allowed[reason] !== 1) reason = 'unknown'

      const bareModel = String(found.model).replace(/^[^:]*:/, '')
      // "已试过的路"要按**实际走过哪条**说：内置表可能正是兜住这条链的那一个，
      // 以前在 `vanilla` 为空时一律打"（这次没走到）"，于是用户以为内置表没参与。
      const trace = Array.isArray(built.trace) ? built.trace : []
      const builtinHits = trace.filter((step) => step.from === 'builtin').map((step) => step.key)
      const builtinConsulted = trace.some((step) => step.from === 'builtin' || step.from === 'none')
      const shells = trace.filter((step) => step.shell === true).map((step) => step.parent)
      const builtinLine = builtinHits.length > 0
        ? '面板内置的原版母模型表：' + builtinHits.join('、') + '（这一条是它兜住的）'
        : (builtinConsulted
          ? '面板内置的原版母模型表：查过，没有 ' + trace.filter((step) => step.from === 'none')
            .map((step) => step.parent).join('、')
          : '面板内置的原版母模型表：这次不需要它')
      const tried = [
        '项目包：' + load.assets + '/models/'
          + (bareModel.indexOf('block/') === 0 ? bareModel : 'block/' + bareModel) + '.json',
        builtinLine,
        directory === '' ? '参考目录：没设，从 jar 现取这条路没走'
          : '参考目录的 jar 现取：' + directory,
      ]
      if (shells.length > 0) {
        tried.push('取回来但是**空壳**（既没有 elements 也没有 parent，等于没取到）：'
          + shells.slice(0, 3).join('、'))
      }
      if (textures.length > 0) {
        tried.push('贴图现取（--textures）：' + (directory === '' ? '没设参考目录，没走' : directory))
      }
      if (langProblems.length > 0) {
        // "已试过的路"里也要看得见：这不是凭空猜的，是真去读了这些文件（而且读失败了）。
        tried.push('语言文件：' + langProblems.map((info) => info.file + '（' + info.why + '）').join('、'))
      }

      const lines = ['[MC 资产面板] 画不出 ' + namespace + ':' + id]
      if (found.guessed === true) {
        lines.push('· blockstate 里一个模型名都没有，按惯例找 ' + String(found.model) + '（这一条是猜的）')
      } else {
        lines.push('· blockstate 引用的模型（' + found.models.length + ' 个）：'
          + found.models.slice(0, 6).join('、') + (found.models.length > 6 ? ' …' : ''))
      }
      lines.push('· 选用的模型：' + String(found.model))
      if (project.length > 0) {
        // **文件在、但读不出来** ≠ 缺失。以前 `readJson` 把 JSON 解析错误吞成 undefined，
        // 报告于是说"项目自己的模型文件缺失 → 补上它"——指向一个明明就在那里的文件，
        // 用户照着"补"只会覆盖掉自己写坏的那份，永远不知道是 JSON 写错了。
        const unreadable = load === undefined || load.unreadableModels === undefined ? new Map() : load.unreadableModels
        const broken = []
        const missing = []
        for (const entry of project) {
          const bare = String(entry.bare === undefined ? entry.name : entry.bare).replace(/^block\//, '')
          const info = unreadable.get('block/' + bare)
          if (info === undefined) missing.push(entry)
          else broken.push(info)
        }
        if (broken.length > 0) {
          lines.push('· 项目自己的模型文件**在，但解析失败**（' + broken.length + ' 个）——不是缺失，不要照"补文件"处理：')
          for (const info of broken) lines.push('  - ' + info.file + ' → ' + info.why)
        }
        if (missing.length > 0) {
          lines.push('· 项目自己的模型文件缺失（' + missing.length + ' 个）：')
          for (const entry of missing) lines.push('  - ' + entry.name + ' → 补 ' + fixPathOf(load, entry, directory))
        }
      }
      if (vanilla.length > 0) {
        lines.push('· 原版母模型缺失（' + vanilla.length + ' 个）：')
        for (const entry of vanilla) lines.push('  - ' + entry.name + ' → ' + fixPathOf(load, entry, directory))
      }
      if (langProblems.length > 0) {
        // "方块名为什么是原始 id"——点名文件与原因，缺文件和写坏了分开说。
        lines.push('· 语言文件读不出来（' + langProblems.length + ' 个）→ 这些文件里的方块名只能用原始 id：')
        for (const info of langProblems) lines.push('  - ' + info.file + ' → ' + info.why)
      }
      if (bareWords.length > 0) {
        lines.push('· 有 ' + bareWords.length + ' 个面把**裸词**当贴图写（模型格式里裸词是路径，不是变量）：')
        for (const one of bareWords.slice(0, 4)) {
          lines.push('  - 面 ' + one.face + ' 引用的是裸词 `' + one.raw + '`。模型格式里它被当成**路径**（'
            + load.namespace + ':textures/' + one.raw + '.png），而不是你 `textures` 映射里的那个键。'
            + '**你大概想写 `#' + one.raw + '`。**')
          if (Array.isArray(one.keys) && one.keys.length > 0) {
            lines.push('    这张模型 textures 里的键：' + one.keys.join('、'))
          }
        }
        if (bareWords.length > 4) lines.push('  - …（还有 ' + (bareWords.length - 4) + ' 个，见结构化诊断）')
      }
      if (dangling.length > 0) {
        lines.push('· 有 ' + dangling.length + ' 个面引用 `#变量`，但模型的 textures 映射里没有这个键：')
        for (const one of dangling.slice(0, 4)) {
          lines.push('  - 面 ' + one.face + ' 引用 `' + one.name + '` → 补上这个键，或改成映射里已有的键')
        }
      }
      // 裸词 / 悬空变量已经在上面单独说过，这里只列**真·路径**解不出来的那些
      // （不然会出现一个"0 个"的标题）。
      const otherTextures = textures.filter((name) =>
        !bareWords.some((one) => one.raw === name) && !dangling.some((one) => one.name === name))
      if (otherTextures.length > 0) {
        lines.push('· 面引用的贴图解不出来（' + otherTextures.length + ' 个，这些面被丢掉了）：')
        for (const name of otherTextures.slice(0, 4)) {
          const entry = textureMissingOf(load, name, directory)
          lines.push('  - ' + entry.name + ' → ' + entry.fixPath)
        }
        if (otherTextures.length > 4) lines.push('  - …（还有 ' + (otherTextures.length - 4) + ' 个，见结构化诊断）')
      }
      if (project.length === 0 && vanilla.length === 0 && textures.length === 0) {
        lines.push(built.noElements === true
          // 这句以前一律说"可能靠方块实体渲染"，把"某个母模型没取到"指成了"这个方块本来就没几何"。
          ? '· 整条模型链里**没有任何 elements**（不是"画出来是空的"）：通常是链上某个母模型'
            + '没取到（空壳/版本不对/参考目录没设），而不是这个方块真的靠方块实体渲染'
          : '· 模型链是完整的，但整条链里一个面都没画出来（这个方块可能靠方块实体渲染）')
      }
      lines.push('· 原因：' + reason)
      if (typeof built.why === 'string' && built.why !== '') lines.push('· 现取失败的原因：' + built.why)
      if (typeof built.textureWhy === 'string' && built.textureWhy !== '') {
        lines.push('· 贴图现取失败的原因：' + built.textureWhy)
      }
      lines.push('· 参考目录：' + (directory === '' ? '（没设）' : directory))
      lines.push('· 已试过的路：' + tried.join(' → '))
      lines.push('· 修法：' + fixTextOf(reason))
      lines.push('· 这份报告只在屏幕上，不写进会话 / inbox / 日志；可以整段复制走')
      if (lines.length > 20) {
        lines.splice(20, lines.length - 20)
        lines[19] = '· …（还省略了一些行；结构化诊断里有全部内容）'
      }
      return { reason: reason, missing: missing, tried: tried, lines: lines }
    }

    /** §2.4 的修法文本：每种 reason 一句能直接照做的。 */
    function fixTextOf(reason) {
      if (reason === 'project-model-missing') {
        return '把上面列出的项目自己的模型文件补上（路径已经给出）；blockstate 里写什么名字，'
          + '文件名就必须是什么（multipart 方块要补的是 _post / _side 那几件，不是 <方块名>.json）'
      }
      if (reason === 'no-reference-directory') {
        return '面板设置里把参考目录指到 .minecraft/versions/<版本>（或写进 mc-art.settings.json 的 '
          + 'reference.directory）；原版母模型都在那个版本的 jar 里'
      }
      if (reason === 'vanilla-parent-missing') {
        return '参考目录指的那个版本里没有这些原版母模型：核对版本号（1.16 之后墙是 template_wall_post / '
          + 'template_wall_side / template_wall_side_tall），或把 parent 改成该版本真实存在的名字'
      }
      if (reason === 'reference-jar-missing') {
        return '参考目录里没找到能读的 jar：指到 .minecraft/versions/<版本>（里面应有 <版本>.jar），'
          + '不要指到 .minecraft 本身'
      }
      if (reason === 'extractor-failed') {
        return '抽取脚本自己失败了：看上面"现取失败的原因"那一行，先确认 Python 与脚本路径'
      }
      if (reason === 'textures-unresolved') {
        return '这些面引用的贴图在项目包里没有、参考目录里也没取到：把参考目录指对版本，'
          + '或者在项目包里补上同名的 PNG（路径已经给出）'
      }
      if (reason === 'texture-missing-hash') {
        return '把这些面里的裸词前面补上 `#`：贴图**变量**必须带 `#`，不带 `#` 的裸词会被当成路径，'
          + '于是去找 <命名空间>:textures/<词>.png（那里通常没有）—— 例如 `"texture": "stone"` 要写 `"texture": "#stone"`。'
          + '这两个方块在游戏里同样是坏的（会渲染成缺失贴图）'
      }
      if (reason === 'texture-variable-unresolved') {
        return '`#变量` 在模型的 textures 映射里找不到：把映射里缺的键补上，或者把面改成映射里已有的那个键'
      }
      if (reason === 'no-quads') {
        return '模型链是完整的但一个面都没画出来：这个方块很可能靠方块实体在代码里渲染，'
          + '面板画不出它的实体模型；要 3D 预览就得在项目包里补一个带 elements 的模型'
      }
      if (reason === 'no-geometry') {
        return '整条模型链里没有任何 elements：先看"已试过的路"那一行 —— 链上哪个母模型是空壳/没取到，'
          + '就补哪个（项目包里的补文件；原版的把参考目录指到 .minecraft/versions/<版本>）。'
          + '这不等于"这个方块靠方块实体渲染"'
      }
      if (reason === 'parent-cycle') {
        return '模型 parent 成环了：把链上重复出现的那个 parent 去掉'
      }
      return '模型链完整却没有 elements：这个方块可能靠方块实体渲染（没有几何模型），'
        + '或者在项目包里补一个带 elements 的模型'
    }

