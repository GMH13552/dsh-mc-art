    async function textureUrl(path) {
      const info = await statOf(path)
      if (info === undefined || info.type !== 'file') return undefined
      const key = path + '@' + String(info.version) + ':' + String(info.size)
      if (textureCache[key] !== undefined) return textureCache[key]
      try {
        const bytes = await readBytesOf(path, 8 * 1024 * 1024)
        if (bytes === undefined) return undefined
        const url = 'data:image/png;base64,' + toBase64(bytes)
        textureCache[key] = url
        return url
      } catch (error) { return undefined }
    }

    // A texture handle is either a file path (a project's own pack) or a
    // `ref:` key into what was already extracted from a jar.  One dispatcher, so
    // no caller has to know which kind it is holding.
    /** `/` 归一的纯路径（解析 `.` / `..`；盘符原样保留大小写，比较时再归）。 */
    function normalizePath(value) {
      let text = String(value === undefined || value === null ? '' : value).split(BACKSLASH).join('/')
      const drive = /^[A-Za-z]:\//.test(text) ? text.slice(0, 2) : ''
      if (drive !== '') text = text.slice(2)
      const lead = text.charAt(0) === '/' ? '/' : ''
      const parts = []
      for (const piece of text.split('/')) {
        if (piece === '' || piece === '.') continue
        if (piece === '..') {
          if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
          else parts.push('..')
          continue
        }
        parts.push(piece)
      }
      return drive + lead + parts.join('/')
    }

    /** Windows 上路径比较不看大小写；POSIX 上看。 */
    const samePath = (left, right) =>
      platformOf() === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

    /**
     * 贴图句柄 → **项目包里的绝对路径**，并且说得出**真实**的拒绝原因。
     *
     * 判据是"归一化之后的真实路径在不在 `<项目>/pack` 底下"，不是字符串前缀草比：
     * 大小写（Windows）、`\` / `/`、`.` / `..` 全部归一。**包内的绝对路径也接受**
     * （解析后落在包里就行）—— 这样即使别处再产出一个绝对句柄，用户也不会被"写不了自己
     * 的贴图"卡死。
     *
     * 旧代码是 `target.indexOf(pack) !== 0`，而用户看到的那句话是"这条贴图句柄不是项目包里
     * 的相对路径"——对着一张明明就在项目包里的图说，自相矛盾。形状（空 / NUL / 盘符 /
     * 前导斜杠 / `..`）现在写在原因里，"拒绝写"三个字保留（icon-test 钉着它）。
     */
    function packPathOf(project, value) {
      const raw = String(value === undefined || value === null ? '' : value)
      if (raw === '') return { ok: false, reason: '贴图句柄是空的，拒绝写' }
      if (raw.indexOf('\u0000') >= 0) return { ok: false, reason: '贴图句柄里有 NUL 字符，拒绝写' }
      const projectDir = normalizePath(String(project.dir))
      const pack = normalizePath(projectDir + '/pack')
      const driveAbsolute = /^[A-Za-z]:[\\/]/.test(raw)
      const absolute = driveAbsolute || raw.charAt(0) === '/' || raw.charAt(0) === BACKSLASH
      // 相对句柄按**项目根**解析（`pack/assets/…` 是相对项目根的），再判它在不在 `<项目>/pack` 底下。
      const at = normalizePath(absolute ? raw : projectDir + '/' + raw.split(BACKSLASH).join('/'))
      const inside = samePath(at, pack) || samePath(at.slice(0, pack.length + 1), pack + '/')
      if (inside) return { ok: true, path: at }
      const shape = driveAbsolute ? '盘符绝对路径'
        : (absolute ? '前导斜杠的绝对路径'
          : (raw.split(/[\\/]/).indexOf('..') >= 0 ? '相对路径里带 ..' : '包内相对路径'))
      return { ok: false, reason: '这条贴图解析之后落在项目包外面（句柄形态：' + shape
        + '；解析后 = ' + at + '；项目包 = ' + pack + '），拒绝写' }
    }

    /**
     * 项目自己的贴图句柄 → 磁盘路径。
     *
     * 句柄有三种形态，都要认：
     *   * `ref:` 句柄 —— 参考 jar 里现取的，调用方另有分支；
     *   * **包内相对路径**（`pack/assets/<ns>/textures/…`）—— `preload()` 现在存的就是这个，
     *     因为它要一路走到客户端编辑器手里，而那里只接受相对路径；
     *   * 绝对路径 —— 历史形态（老版本存过），别的调用方也可能给。
     * 相对的一律按**项目根**解析：不解析就是"读不到自己项目里的图"。
     */
    function textureFileOf(project, value) {
      const text = String(value === undefined || value === null ? '' : value).split(BACKSLASH).join('/')
      if (text === '' || text.slice(0, 4) === 'ref:') return text
      if (/^[A-Za-z]:\//.test(text) || text.charAt(0) === '/') return text
      const dir = project !== undefined && project !== null && typeof project.dir === 'string'
        ? String(project.dir).split(BACKSLASH).join('/').replace(/\/+$/, '') : ''
      return dir === '' ? text : dir + '/' + text.replace(/^\.\//, '')
    }

    async function textureUrlFor(entry, project) {
      if (typeof entry !== 'string' || entry === '') return undefined
      if (entry.slice(0, 4) === 'ref:') return referenceTextures.get(entry)
      return await textureUrl(textureFileOf(project, entry))
    }

    // Animated textures are the ONE thing a texture id alone cannot describe.
    // Every payload that ships texture URLs ships this beside them, so the
    // viewer animates whatever it was actually given instead of a list of
    // block names somebody kept up to date by hand.
    function animationsFor(ids) {
      const out = {}
      for (const id of ids) {
        // **两个表都查**：参考侧（jar 里取的）在 `referenceAnimations`，项目侧（包里自己的
        // `.mcmeta`）在各自 load 的 `animations` 里。以前只查参考侧，于是**项目自己的动图
        // 在面板里不被当动图**：整条竖条被当成一张贴图贴上去（糊），而游戏里它是动的。
        const animation = referenceAnimations.get(id)
        if (animation !== undefined) { out[id] = animation; continue }
        for (const load of preloads.values()) {
          const own = load.animations === undefined ? undefined : load.animations.get(id)
          if (own !== undefined) { out[id] = own; break }
        }
      }
      return out
    }

    /**
     * 与 `animationsFor` 配套：**条带形状但动画用不了**的贴图，给出真话（客户端原样显示）。
     *
     * 三种情况必须分开，因为修法不同：
     *   1. `.mcmeta` 在、解析成功 → 进 `animations`，**不产生提示**；
     *   2. `.mcmeta` 在、但读不了/不是 JSON/没有 animation 段/图不是竖条 → 这里的 `text`
     *      （"**有** `.mcmeta` 但我读不了它：<原因>"）—— 这是在说**我们**的问题；
     *   3. 旁边真的没有 `.mcmeta` → 宿主不说话（客户端按解码出来的形状说"没有动画描述"，
     *      那才是对的）。绝不能在有文件的情况下说"没有动画描述"。
     */
    function animationNotesFor(ids) {
      const out = {}
      for (const id of ids) {
        for (const load of preloads.values()) {
          const note = load.animationNotes === undefined ? undefined : load.animationNotes.get(id)
          if (note !== undefined) { out[id] = note; break }
        }
      }
      return out
    }

    /**
     * 项目包里一张 PNG 旁边的 `.mcmeta` 怎么说 —— 判据与抽取器的 `animation_of()` **同一套**
     * （不然参考贴图和项目贴图的动画行为会漂移）。
     *
     * 三种结果：
     *   `{ animation }`  合法、而且图确实是竖条 → 交给播放器；
     *   `{ why }`        **有** `.mcmeta` 但用不了（读不到 / 不是 JSON / 没有 animation 段 /
     *                    图不是竖条）—— 原因要留着，报告里说成"我读不了"，不许说成"没有描述"；
     *   `undefined`      旁边没有 `.mcmeta`（这是客户端自己那句话的情形）。
     */
    async function projectAnimationOf(pngPath) {
      let text
      try { text = await readTextOf(pngPath + '.mcmeta') } catch (error) { text = undefined }
      if (text === undefined || text === null) return { why: '.mcmeta 读不出来（权限、编码或文件损坏）' }
      let parsed
      try { parsed = JSON.parse(String(text)) } catch (error) {
        return { why: '.mcmeta 不是合法 JSON：' + messageOf(error) }
      }
      const declared = parsed !== null && typeof parsed === 'object' ? parsed.animation : undefined
      if (declared === null || declared === undefined || typeof declared !== 'object') {
        return { why: '.mcmeta 里没有 animation 段' }
      }
      let bytes
      try { bytes = await readBytesOf(pngPath, 16 * 1024 * 1024) } catch (error) { bytes = undefined }
      const size = pngSizeOf(bytes)
      if (size === undefined) return { why: 'PNG 的尺寸读不出来（文件可能坏了）' }
      if (size.height <= size.width || size.height % size.width !== 0) {
        return { why: '图不是竖条（' + size.width + '×' + size.height + '；高必须是宽的整数倍）' }
      }
      const strip = Math.trunc(size.height / size.width)
      const order = []
      const listed = declared.frames
      if (Array.isArray(listed)) {
        for (const item of listed) {
          const index = item !== null && typeof item === 'object' ? item.index : item
          const number = Math.trunc(Number(index))
          if (isFinite(number) && number >= 0 && number < strip) order.push(number)
        }
      }
      if (order.length === 0) for (let index = 0; index < strip; index++) order.push(index)
      const declaredTime = Math.trunc(Number(declared.frametime === undefined ? 1 : declared.frametime))
      return { animation: {
        frames: order.length,
        strip: strip,
        order: order,
        frametime: !isFinite(declaredTime) || declaredTime < 1 ? 1 : declaredTime,
        interpolate: declared.interpolate === true,
      } }
    }

