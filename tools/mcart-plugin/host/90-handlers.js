    ctx.effect(() => harness.handle('atlas.pickDirectory', async (args) => {
      const request = args || {}
      const start = typeof request.start === 'string' ? request.start : ''
      // 不要因为"没有 shell 服务"就放弃：subprocess 一样能起 powershell.exe 弹对话框
      // （用户桌面端就是这种宿主：会话里的 pwsh 好用，宿主层拿不到 shell 服务）。
      if (shellOf() === undefined && subprocessOf() === undefined) {
        return { supported: false, detail: '宿主既没有 shell 服务也没有 subprocess，起不了目录对话框。' }
      }
      try {
        const powerShell = await windowsPowerShell()
        if (powerShell !== null) {
          const winStart = await convertPath('-w', start)
          const lines = [
            '$ProgressPreference = "SilentlyContinue"',
            'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
            '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
            "$d.Description = '选择目录'",
            '$d.ShowNewFolderButton = $false',
          ]
          if (winStart !== null) lines.push("$d.SelectedPath = '" + winStart.split("'").join("''") + "'")
          lines.push('if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write("' + PICK_BEGIN + '" + $d.SelectedPath + "' + PICK_END + '") }')
          // 优先 argv 起（不需要 shell 服务）。桌面端实测：会话里的 pwsh 工具好用，
          // 但宿主层拿不到 shell 服务 —— 那种情况下这条路是唯一能弹对话框的。
          const encoded = utf16leBase64(lines.join('\n'))
          const dialog = await withDeadline(async () => {
            let text = ''
            const argvRun = await runProcess([powerShell, '-NoProfile', '-STA', '-EncodedCommand', encoded],
              { cwd: start, maxBytes: 64 * 1024, graceMs: 3000 })
            if (argvRun !== null) text = String(argvRun.text)
            if (text === '' && shellOf() !== undefined) {
              const quoting = await currentShell(start)
              text = await runDialog(quoting.word(powerShell) + ' -NoProfile -STA -EncodedCommand ' + encoded,
                policyFor(start))
            }
            return text
          }, 120000)
          if (dialog !== null && typeof dialog === 'object' && dialog.deadlineExpired === true) {
            return { supported: false, platform: platformOf() || null,
              detail: '目录对话框 120 秒没有返回 —— 这条路在你的环境里可能用不了（对话框既不显示也不结束）。' }
          }
          const output = String(dialog)
          const picked = betweenMarkers(output)
          if (picked === '') return { supported: true, cancelled: true, via: 'windows', exe: powerShell }
          const converted = await convertPath('-u', picked)
          const usable = converted !== null ? converted : picked
          const info = await statOf(usable)
          if (info !== undefined && info.type === 'directory') return { path: usable, raw: picked, via: 'windows', exe: powerShell }
          return { supported: true, error: '你选的是 ' + picked + '，但宿主打不开它（转换后：' + usable + '）。' }
        }
        const linuxPickers = [
          { tool: 'zenity', command: 'zenity --file-selection --directory --title="选择目录"' },
          { tool: 'yad', command: 'yad --file --directory --title="选择目录"' },
          { tool: 'kdialog', command: 'kdialog --getexistingdirectory "$HOME" "选择目录"' },
        ]
        for (const picker of linuxPickers) {
          if (!(await available(picker.tool))) continue
          const picked = beforeStderr(await runDialog(picker.command))
          if (picked === '') return { supported: true, cancelled: true, via: picker.tool }
          const info = await statOf(picked)
          if (info !== undefined && info.type === 'directory') return { path: picked, raw: picked, via: picker.tool }
          return { supported: true, error: '选择器返回了 ' + picked + '，但打不开这个目录。' }
        }
        // 措辞要**如实**：说的是"这台宿主里没找到可用的对话框"，并且把平台与试过的东西
        // 都写出来 —— 上一版在这里断言"没有 powershell.exe"，而 Windows 上那句话
        // 基本一定是错的（真实原因是方言探针失败，命令按 bash 拼的）。
        return { supported: false, platform: platformOf() || null, shellDialect: shellDialect,
          detail: '这个宿主里没找到能用的目录对话框（平台 ' + (platformOf() || '问不到') +
            '；试过 powershell.exe 的绝对路径与 PATH、以及 zenity/yad/kdialog）。' }
      } catch (error) {
        return { error: '目录选择器出错：' + String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.settings', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const file = project.dir + '/mc-art.settings.json'
        const stored = (await readJson(file)) || {}
        const reference = stored.reference !== null && typeof stored.reference === 'object' ? stored.reference : {}
        const chosen = reference.mods !== null && typeof reference.mods === 'object' ? reference.mods : {}
        // No directory is invented here.  This used to fall back to
        // <project>/refroot, purely because that folder happened to exist, so the
        // panel reported the 12 hand-picked textures in it as "the reference"
        // while the real vanilla + mod assets were never opened.  Unset stays
        // unset, and the panel says so instead of showing a wrong answer.
        const directory = typeof reference.directory === 'string' ? reference.directory : ''
        const scanner = await findScanner(project.dir)
        const scanned = await scanReference(scanner, directory)
        const detected = directory === '' ? await detectGameRoots(project.dir) : []
        return {
          // Both the absolute file and the workspace-relative one: the skill
          // reads the file, and "@ 提意见"/"让 AI 知道" needs a path it can name.
          // Guessing `<project>/mc-art.settings.json` is the guess that breaks
          // when a project is not a direct child of the root.
          path: rel(root, file),
          project: project.id, title: project.title, file: file,
          directory: directory,
          shape: scanned.shape, textures: scanned.textures,
          sources: (scanned.sources || []).slice(0, 80),
          scanError: scanned.error,
          scanner: scanner,
          detected: detected,
          includeGenerated: reference.includeGenerated !== false,
          includeMods: reference.includeMods !== false,
          mods: (scanned.namespaces || []).map((item) => ({ name: item.name, count: item.count,
            from: item.from || [], on: chosen[item.name] !== false })),
        }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // 「面板到底去哪儿找过游戏目录」——一条命令看清候选与命中。
    // 设置页那条"检测到 … 用它"曾经在 Windows 上永远是空的（检测逻辑是 WSL 形状的），
    // 而界面上没有别的办法指定参考目录。这条方法让"为什么没检测到"变成一句话。
    ctx.effect(() => harness.handle('atlas.gameRoots', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const project = projectId === '' ? undefined : await projectFor(root, projectId)
        const near = project === undefined ? root : project.dir
        return { near: near, candidates: gameRootCandidates(near), detected: await detectGameRoots(near),
          platform: typeof process === 'undefined' ? null : process.platform }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.saveSettings', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const mods = {}
        if (request.mods !== null && typeof request.mods === 'object') {
          for (const key of Object.keys(request.mods)) {
            if (typeof request.mods[key] === 'boolean') mods[key] = request.mods[key]
          }
        }
        const file = project.dir + '/mc-art.settings.json'
        // Merge, do not replace.  This writer used to emit a fixed object, so
        // any field it did not know about -- `reference.version`, say -- was
        // silently deleted the next time the panel saved.  A file that declares
        // its own schema version must not lose what a newer reader added.
        const stored = (await readJson(file)) || {}
        const storedReference = stored.reference !== null && typeof stored.reference === 'object'
          ? stored.reference : {}
        const payload = Object.assign({}, stored, {
          schema: 'mc-art.settings/1',
          reference: Object.assign({}, storedReference, {
            directory: typeof request.directory === 'string' ? request.directory : '',
            includeGenerated: request.includeGenerated !== false,
            includeMods: request.includeMods !== false,
            mods: mods,
          }),
        })
        const outcome = await writeTextFile(file, JSON.stringify(payload, null, 2) + '\n', root)
        if (outcome.ok !== true) return { error: String(outcome.detail) }
        return { saved: true, file: file, path: rel(root, file), via: outcome.via }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // The fs service has no binary write: `writeText` decodes and re-encodes
    // UTF-8, which corrupts a PNG.  Bytes therefore go through the shell the
    // same way the settings file already does -- and the result is read back
    // and checked, because a half-written or non-PNG file would only show up
    // much later as a mysteriously broken texture.
    const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10]

    ctx.effect(() => harness.handle('atlas.saveTexture', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const path = typeof request.path === 'string' ? request.path : ''
      const base64 = typeof request.base64 === 'string' ? request.base64 : ''
      if (path === '') return { error: '贴图句柄是空的，拒绝写' }
      if (base64 === '') return { error: '缺少图像数据' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        // An ITEM's textures arrive as `ref:` handles (`ref:<命名空间>:item/<物品>`),
        // because that is how the flat-icon path names them; a block's arrive as
        // paths.  The pen writes FILES, so a handle has to be resolved to the one
        // it stands for -- this is the whole reason "血晶这种物体不能修改贴图".
        // The map is filled while the item is extracted, from the extractor's own
        // `textureFiles`, so it is the real file and not a guess from the name.
        let target = path
        if (path.slice(0, 4) === 'ref:') {
          const resolved = editablePaths.get(path)
          if (resolved === undefined) {
            return { error: '这张贴图不在这个项目的资源包里（它在参考的 jar 里），改不了：' + path }
          }
          target = resolved
        }
        // **按解析后的真实路径判"在不在包里"**，并说出真实原因（空 / NUL / 盘符 / 前导
        // 斜杠 / `..` / 包外）。包内的绝对路径也接受：解析后落在 `<项目>/pack` 里就行。
        const placed = packPathOf(project, target)
        if (placed.ok !== true) {
          // This is a brush, not a general file writer.
          return { error: placed.reason + '：' + String(target) }
        }
        target = placed.path
        // Write beside the original, check it, and only then move it into place.
        // Writing straight over the texture meant a bad encode destroyed the
        // sprite *before* anyone noticed it was not a PNG.
        //
        // 三个动作（写/移/删）都按 shell 方言拼：Windows 上这条路径原来写的
        // `printf | base64 -d`、`mv -f`、`rm -f` 一个都不是命令，而贴图正是
        // 面板最核心的写入——不修的话 Windows 用户"能看不能改"。
        // 这里**不再**用 shellOf() 提前退出：写字节的退路是 node:fs 垫片，
        // 移/删也各有一条，四条路都断了才会在下面逐条报出来。
        const temp = target + '.mcart-tmp'
        async function discard(reason) {
          const cleanup = await removeFile(temp, root)
          return { error: reason + (cleanup.ok === true ? '（原文件没有被改动）' : '（临时文件也没清掉：' + temp + '）') }
        }
        const written = await writeDecodedFile(temp, base64, root, 30000)
        if (written.ok !== true) {
          const detail = beforeStderr(written.err === undefined || written.err === null ? '' : written.err)
          return await discard('写入失败（退出码 ' + written.exitCode + '，第 ' + written.step + '/' + written.steps + ' 步）' +
            (detail === '' ? '，没有错误输出' : '：' + detail))
        }
        const staged = await statOf(temp)
        if (staged === undefined || staged.type !== 'file') return await discard('写完之后读不到临时文件')
        if (staged.size === undefined || staged.size === 0) return await discard('写出来的是个空文件')
        const bytes = await readBytesOf(temp, 8 * 1024 * 1024)
        if (bytes === undefined) return await discard('写完之后读不出它的字节')
        for (let i = 0; i < PNG_MAGIC.length; i++) {
          if (bytes[i] !== PNG_MAGIC[i]) {
            return await discard('写出来的不是 PNG（开头 ' + Array.prototype.slice.call(bytes, 0, 8).join(',') + '）')
          }
        }
        const moved = await moveFile(temp, target, root)
        if (moved.ok !== true) {
          return await discard('换上新图失败（退出码 ' + String(moved.exitCode) + '）：' + String(moved.detail))
        }
        const info = await statOf(target)
        if (info === undefined || info.type !== 'file') return { error: '换上新图之后读不到它：' + target }
        return { saved: true, path: target, bytes: info.size }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // The atlas is normally produced by tools/emit_atlas.py; this is the one
    // place the viewer writes it, and only the `cells` of one entry.  A manual
    // structure therefore makes `emit_atlas.py --check` report drift, which is
    // the truth: the file is no longer only what the generator produced.
    // 新建一个项目（= 一个模组 = 一个命名空间）。
    //
    // 为什么要有它：空目录里面板只能说"没找到项目"，新手卡在第一步。这里写最小骨架 ——
    // `mc-art.atlas.json` + `pack/assets/<命名空间>/` 下的几个空目录（宿主靠这两样认项目）。
    // **一个模组一个命名空间**是硬约束：目录里已经有别的命名空间就拒绝，免得一个模组里
    // 长出第二个命名空间（那正好是"一个命名空间一个真相"要防的事）。
    const PROJECT_ID = /^[a-z0-9_]{2,32}$/
    ctx.effect(() => harness.handle('atlas.createProject', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const id = typeof request.id === 'string' ? request.id.trim() : ''
      const asked = typeof request.namespace === 'string' ? request.namespace.trim() : ''
      const namespace = asked === '' ? id : asked
      if (root === '') return { error: '没有给定根目录' }
      if (!PROJECT_ID.test(id)) return { error: '项目 id 只能用小写字母、数字、下划线，2-32 个字符：' + JSON.stringify(id) }
      if (!PROJECT_ID.test(namespace)) return { error: '命名空间只能用小写字母、数字、下划线，2-32 个字符：' + JSON.stringify(namespace) }
      try {
        const dir = root + '/' + id
        if ((await statOf(dir + '/mc-art.atlas.json')) !== undefined) {
          return { error: '这个目录里已经有项目了：' + id }
        }
        const existing = (await listDir(dir + '/pack/assets')).filter((entry) => entry.type === 'directory')
        const others = existing.map((entry) => entry.name)
        if (others.length > 0 && others.indexOf(namespace) < 0) {
          return { error: '这个项目的资源包里已经有命名空间 ' + others.join('、') +
            '。一个模组只用一个命名空间：用已有的那个，或者换一个目录。' }
        }
        // **先建目录再写文件**——但不是因为 fs.writeText 建不了父目录
        // （`dsh-fs-local` 的 writeFileAtomic 第一句就是 mkdir recursive；第一版之所以
        // 看到 ENOENT，是本地测试桩的 writeText 比真货**严**：桩不建父目录。桩比被替身的
        // 东西更严，是一个永远不会红的门禁。桩已经改成和真货一样），而是因为骨架目录本来
        // 就该由"建项目"这一步建出来，而不是碰到哪个文件才顺手长出来。
        const folders = ['pack', 'pack/assets', 'pack/assets/' + namespace,
          'pack/assets/' + namespace + '/textures/block', 'pack/assets/' + namespace + '/models/block',
          'pack/assets/' + namespace + '/blockstates', 'pack/assets/' + namespace + '/lang']
        // 建目录这件事有四条路（见 ensureDir）。同一个项目里的目录只要第一条路走通了
        // 就不再试后面的——失败了却要一次说清，所以失败时把原因并起来。
        //
        // **项目目录自己也要先建出来**：`directoryPickerController.createDirectory` 是
        // 非递归的（父目录必须在），所以不能只建 pack —— 之前只建 pack 的那版，
        // 一旦走到选择器那条路就是 ENOENT（门禁当场抓到）。
        const used = {}
        let placeholder = false
        const targets = [dir].concat(folders.map((folder) => dir + '/' + folder))
        for (const target of targets) {
          const made = await ensureDir(target, root)
          if (made.ok !== true) {
            return { error: '建目录失败：' + rel(root, target) + ' → ' + String(made.detail),
              dir: dir, folders: folders.length }
          }
          used[made.via] = (used[made.via] === undefined ? 0 : used[made.via]) + 1
          if (made.placeholder === true) placeholder = true
        }
        const atlas = { schema: 'mc-art.atlas/1', namespace: namespace,
          biomes: [], structures: [], entities: [], blocks: [] }
        const wrote = await writeTextFile(dir + '/mc-art.atlas.json', JSON.stringify(atlas, null, 2) + '\n', root)
        if (wrote.ok !== true) return { error: '写 atlas 失败：' + String(wrote.detail) }
        return { created: true, id: id, namespace: namespace, dir: dir,
          atlas: rel(root, dir + '/mc-art.atlas.json'), folders: folders.length,
          via: Object.keys(used).sort().map((key) => key + '×' + used[key]).join(' + '),
          placeholder: placeholder, atlasVia: wrote.via }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.saveVoxel', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const kind = request.kind === 'biome' ? 'biome' : (request.kind === 'structure' ? 'structure' : '')
      const id = typeof request.id === 'string' ? request.id : ''
      if (kind === '' || id === '') return { error: '只有群系和多方块结构能这样改' }
      const cells = normalizeCells(request.cells)
      if (cells.length === 0) return { error: '一格都没有，拒绝把结构写空' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        // One cell holds one block.  Two at the same coordinate have exactly
        // equal depth, so the strict test keeps whichever drew first and the
        // other disappears without a word while the palette still counts it.
        const taken = {}
        for (const cell of cells) {
          const at = cell.at.join(',')
          if (taken[at] === true) return { error: '同一个格子放了两个方块：' + at }
          taken[at] = true
        }
        const file = project.dir + '/mc-art.atlas.json'
        const atlas = await readJson(file)
        if (atlas === undefined) return { error: '读不了图谱：' + file }
        const key = kind === 'biome' ? 'biomes' : 'structures'
        const list = Array.isArray(atlas[key]) ? atlas[key] : []
        const item = list.filter((entry) => entry.id === id)[0]
        if (item === undefined) return { error: '图谱里没有这个 ' + kind + '：' + id }
        item.cells = cells
        const outcome = await writeTextFile(file, JSON.stringify(atlas, null, 2) + '\n', root)
        if (outcome.ok !== true) return { error: String(outcome.detail) }
        return { saved: true, file: file, kind: kind, id: id, cells: cells.length, via: outcome.via }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // The ghost for one block at one coordinate, plus the textures it needs.
    ctx.effect(() => harness.handle('atlas.preview', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const block = typeof request.block === 'string' ? request.block : ''
      // `at` is optional: the viewer asks for the brush block at the origin
      // just to learn its 朝向 choices, before anything is hovered.
      const at = Array.isArray(request.at) && request.at.length >= 3
        ? [Math.trunc(request.at[0]), Math.trunc(request.at[1]), Math.trunc(request.at[2])] : [0, 0, 0]
      const variant = typeof request.variant === 'string' && request.variant !== '' ? request.variant : null
      // The neighbours the viewer can see around the hovered cell.  Offsets are
      // relative to `at`, so the ghost is drawn from the same rules the placed
      // block will be.
      const around = Array.isArray(request.around) ? request.around.slice(0, 32) : []
      if (block === '') return { error: '预览需要方块名' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const built = await blockQuadsAt(root, project, block, at, variant, around)
        if (built.error !== undefined) return { error: built.error }
        const textureIds = []
        const seen = {}
        for (const quad of built.quads) if (seen[quad.tex] !== true) { seen[quad.tex] = true; textureIds.push(quad.tex) }
        const already = {}
        if (Array.isArray(request.have)) for (const path of request.have) already[path] = true
        const textures = {}
        for (const path of textureIds) {
          if (already[path] === true) continue
          const url = await textureUrlFor(path, project)
          if (url !== undefined) textures[path] = url
        }
        return { block: block, at: at, quads: built.quads, textureIds: textureIds, textures: textures,
          animations: animationsFor(textureIds), animationNotes: animationNotesFor(textureIds),
          variants: built.variants || [], axes: built.axes || [], defaults: built.defaults || {},
          multipart: built.multipart === true, derived: built.derived === true,
          variant: built.variant === undefined ? null : built.variant }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // A 16x16 icon per block, for the hotbar.  The first texture the model
    // reaches is the one a player would recognise.
    ctx.effect(() => harness.handle('atlas.icons', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const wanted = Array.isArray(request.blocks) ? request.blocks.slice(0, 120) : []
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const icons = {}
        const failed = []
        for (const block of wanted) {
          if (typeof block !== 'string' || block === '' || icons[block] !== undefined) continue
          const reference = block
          const colon = reference.indexOf(':')
          const namespace = colon >= 0 ? reference.slice(0, colon) : project.namespace
          const name = colon >= 0 ? reference.slice(colon + 1) : reference
          const load = await ensure(namespace)
          if (load === undefined) { failed.push(reference + '（资源包 ' + namespace + ' 没载入）'); continue }
          const elements = elementsOf(load, 'block/' + name)
          if (elements === undefined) { failed.push(reference + '（没有模型）'); continue }
          const first = elements.length > 0 && elements[0].faces !== undefined
            ? Object.keys(elements[0].faces)[0] : undefined
          const tex = first === undefined ? undefined : elements[0].faces[first].tex
          const url = tex === undefined ? undefined : await textureUrlFor(tex, project)
          if (url === undefined) { failed.push(reference + '（没有贴图）'); continue }
          icons[block] = url
        }
        return { icons: icons, failed: failed.slice(0, 6) }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.scan', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      if (root === '') return { rootSpecified: false, projects: [], errors: [] }
      errors.length = 0
      const index = await indexOf(root)
      const projects = index.projects.map((project) => ({
        id: project.id, title: project.title, namespace: project.namespace, root: project.root,
        items: {
          biome: project.biomes.map((item) => ({ id: item.id, title: item.title })),
          structure: project.structures.map((item) => ({ id: item.id, title: item.title })),
          entity: project.entities.map((item) => ({ id: item.id, title: item.title })),
          block: project.blocks.map((item) => ({ id: item.id, title: item.title })),
        },
      }))
      return { rootSpecified: true, root: root, projects: projects, errors: errors.slice(0, 8), cached: index.cached }
    }))

    ctx.effect(() => harness.handle('atlas.projects', async (args) => {
      const request = args || {}
      const base = typeof request.path === 'string' ? request.path : ''
      if (base === '') return { error: '没有给定目录' }
      try {
        const parents = []
        const addParent = (value) => { if (value !== null && value !== undefined && parents.indexOf(value) < 0) parents.push(value) }
        if (await looksLikeProject(base)) addParent(parentOf(base))
        const entries = await listDir(base)
        for (const entry of entries) {
          if (entry.type !== 'directory') continue
          const child = entry.target !== undefined && typeof entry.target.displayPath === 'string' && entry.target.displayPath.length > 0
            ? entry.target.displayPath : base + '/' + entry.name
          if (await looksLikeProject(child)) addParent(base)
        }
        const results = []
        for (const parent of parents) {
          const index = await indexOf(parent)
          for (const project of index.projects) {
            results.push({ root: parent, id: project.id, title: project.title, namespace: project.namespace, dir: project.dir })
          }
        }
        return { base: base, projects: results }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // 「这台机器上我到底能看见什么」——一句话问清。
    //
    // 存在的理由很具体：面板上一句"宿主没有 shell 服务时建不出目录"曾经让人以为
    // 服务真的不在，而实际上那句话谁也没查过。现在失败信息自己带原因（见 ensureDir），
    // 这个方法把同一件事变成**可读的一行**：哪些服务在、哪条退路可用、方言是什么。
    // 别人机器上再出问题，让他们点一下这个，比猜十轮快。
    ctx.effect(() => harness.handle('atlas.env', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' && request.root !== '' ? request.root : '.'
      const picker = ctx.get('directoryPickerController')
      const services = {
        fs: fsOf() !== undefined,
        shell: shellOf() !== undefined,
        sessions: sessionsOf() !== undefined,
        webServer: ctx.get('webServer') !== undefined,
        directoryPickerController: picker !== undefined && typeof picker.createDirectory === 'function',
        localFs: localOf() !== null,
        subprocess: ctx.get('subprocess') !== undefined,
      }
      let dialect = null
      if (services.shell) {
        try { dialect = (await currentShell('')).name } catch (error) { dialect = 'probe failed: ' + messageOf(error) }
      }
      const missing = Object.keys(services).filter((key) => services[key] !== true)
      // 参考目录这条路依赖的三样东西分别在哪儿 —— 它们每一个都曾经"看着有、其实没有"，
      // 而失败信息里说不清。这里一次答完：脚本路径、Python 解释器、捆绑运行时目录、
      // 以及 shell 方言是**按平台定的**还是探针说的。
      const scanner = await findScanner(root)
      const extractor = await findTool(root, EXTRACT_SCRIPT)
      let python = null
      try { python = await resolvePython(root) } catch (error) { python = 'probe failed: ' + messageOf(error) }
      return { services: services, shellDialect: dialect,
        platform: platformOf() || null,
        node: typeof process === 'undefined' ? null : process.version,
        missing: missing,
        scanner: scanner, extractor: extractor, python: python, pythonVia: pythonVia,
        pythonCandidates: pythonCandidates().slice(0, 8),
        bundledPythonDirs: bundledPythonDirs(),
        shellProbe: shellProbeInfo,
        powershell: platformOf() === 'win32' ? await windowsPowerShell() : null,
        moduleDir: moduleDirOf() || null,
        note: missing.length === 0 ? '每一条路都在。'
          : '缺 ' + missing.join('、') + '；每一件写入都会自动走能用的那条路（建目录/写文件/写字节各有退路），结果里会写 via=…' }
    }))

    ctx.effect(() => harness.handle('atlas.scene', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      if (root === '') return { error: 'no asset root specified' }
      try {
        const index = await indexOf(root)
        const project = index.projects.filter((item) => item.id === request.project)[0]
        if (project === undefined) return { error: 'project not found: ' + request.project }
        return await payload(root, project, request.kind, request.id, request.have, request.cells,
          request.neighbours)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.session', async (args) => {
      const request = args || {}
      try {
        const id = typeof request.sessionId === 'string' ? request.sessionId : ''
        const session = (sessionsOf() === undefined || id === '') ? undefined : sessionsOf().get(id)
        if (session === undefined) return { cwd: null }
        const cwd = session.header.cwd
        return { cwd: typeof cwd === 'string' ? cwd : null }
      } catch (error) {
        return { cwd: null, error: String(error && error.message ? error.message : error) }
      }
    }))

    // Which namespaces the reference can offer, so the builder can let the user
    // pick vanilla or a mod instead of only the open project's own blocks.
    ctx.effect(() => harness.handle('atlas.refNamespaces', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const directory = await referenceDirectory(project)
        if (directory === '') return { namespaces: [], directory: '', reason: '没有设置参考目录' }
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
        // The count must be BLOCKSTATES in the version the extractor will
        // actually read.  The PNG scanner counts textures across every installed
        // version, so it reported "minecraft 13209 张" for a namespace this tool
        // can offer 407 blocks out of -- a number you cannot get.
        const parsed = await runScanner(extractor, ['--root', directory, '--namespaces'],
          120000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
        }
        // A mod that ships only sounds or textures is not a choice; listing it
        // only to say "没有方块" when picked is noise.
        const out = (parsed.namespaces || []).filter((item) => item.blocks > 0)
        return { directory: directory, version: parsed.version, versionWhy: parsed.versionWhy,
          namespaces: out, extractor: extractor }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // The item picker's list: names, presentation form and family, no textures
    // (a page's icons are fetched separately, one process for the whole page).
    ctx.effect(() => harness.handle('atlas.refItems', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      const source = request.source === 'project' ? 'project' : 'reference'
      if (namespace === '') return { error: '没有指定命名空间' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        return await itemFactsList(project, namespace, source)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // One page of icons, recipes and textures together.
    ctx.effect(() => harness.handle('atlas.itemIcons', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      const wanted = Array.isArray(request.items) ? request.items.slice(0, 60) : []
      const source = request.source === 'project' ? 'project' : 'reference'
      if (namespace === '' || wanted.length === 0) return { items: {} }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        return await itemIconPage(project, namespace, wanted.filter((id) => typeof id === 'string' && id !== ''), source)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // One item, with its texture payload (the big preview, and the 3D switch).
    ctx.effect(() => harness.handle('atlas.icon', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      const item = typeof request.item === 'string' ? request.item : ''
      const source = request.source === 'project' ? 'project' : 'reference'
      if (namespace === '' || item === '') return { error: '图标需要一个命名空间和一个物品名' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const entry = await referenceLoadItem(root, project, namespace, item, source)
        if (entry.error !== undefined) return { error: entry.error }
        return await itemIcon(namespace, entry.parsed, request.have, project)
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.refBlocks', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      if (namespace === '') return { error: '没有指定命名空间' }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const directory = await referenceDirectory(project)
        if (directory === '') return { error: '还没有设置参考目录' }
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
        const signature = await refSignatureOf(directory)
        const cacheKey = 'list:' + namespace
        const cached = referenceBlocks.get(cacheKey)
        if (cached !== undefined && cached.signature === signature) return cached.value
        const parsed = await runScanner(extractor, ['--root', directory, '--list', '--namespace', namespace],
          120000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
        }
        const value = { namespace: namespace, version: parsed.version, blocks: parsed.blocks || [] }
        referenceBlocks.set(cacheKey, { signature: signature, value: value })
        return value
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // Icons for a whole namespace in ONE process.  One process per block measured
    // at ~0.4s, which would be half a minute of nothing for a hotbar row.
    ctx.effect(() => harness.handle('atlas.refIcons', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const namespace = typeof request.namespace === 'string' ? request.namespace : ''
      const wanted = Array.isArray(request.blocks) ? request.blocks.slice(0, 120) : []
      if (namespace === '' || wanted.length === 0) return { icons: {}, names: {} }
      try {
        const project = await projectFor(root, projectId)
        if (project === undefined) return { error: '找不到项目：' + projectId }
        const directory = await referenceDirectory(project)
        if (directory === '') return { error: '还没有设置参考目录' }
        const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
        if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
        const parsed = await runScanner(extractor,
          ['--root', directory, '--namespace', namespace, '--icons', wanted.join(',')],
          180000, project.dir, REFERENCE_MAX_BYTES)
        if (parsed === undefined || parsed.error !== undefined) {
          return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
        }
        const icons = {}
        const names = {}
        const failed = Array.isArray(parsed.failed) ? parsed.failed : []
        for (const id of Object.keys(parsed.icons || {})) {
          const item = parsed.icons[id]
          const key = namespace + ':' + id
          // 和 `atlas.itemIcons` 同一条判据：**一个坏条目不许把整批带下水**。
          // 以前这里直接拼 `item.png`、直接取 `item.name`：前者缺数据时变成字面量
          // `data:image/png;base64,undefined`（一格的破图），后者只要缺字段就是
          // `undefined` —— 而运行时拒收含 undefined 的返回值，整批一起失败。
          // 失败不只"丢掉这一格"：`failed` 里点名 id 和**真实原因**，报告才说得出话。
          const problem = refIconEntryProblem(item)
          if (problem !== null) { failed.push(id + '（没有图标数据：' + problem + '）'); continue }
          icons[key] = 'data:image/png;base64,' + item.png
          // Keyed exactly like a project icon (`namespace:id`) so the hotbar does
          // not care which kind of block it is holding.
          names[key] = typeof item.name === 'string' && item.name !== '' ? item.name : id
        }
        return { icons: icons, names: names, failed: failed, version: parsed.version }
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) }
      }
    }))

    // Drop extracted blocks nothing references any more.  The user's rule:
    // extract on demand, keep what is actually used, forget it when the block is
    // deleted.  `keep` is what the caller still holds, so this cannot guess.
    // What SURVIVES decides which shared `ref:` handles may go -- see
    // `releaseUnused`, which is where that lives so it can be tested on its own.
    ctx.effect(() => harness.handle('atlas.releaseRefs', async (args) => {
      const request = args || {}
      const keep = {}
      if (Array.isArray(request.keep)) for (const key of request.keep) keep[String(key)] = true
      return releaseUnused(referenceBlocks, keep, referenceTextures, referenceAnimations)
    }))

    console.log('mc-art atlas host ready (unqualified cell blocks resolve to their project; vanilla and mod blocks are extracted on demand)')
}
