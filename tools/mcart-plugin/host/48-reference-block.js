    async function referenceLoad(root, project, namespace, block, variant) {
      const wanted = typeof variant === 'string' && variant !== '' ? variant : null
      // The cache key includes the variant: `oak_log` upright and `oak_log`
      // lying down are two different extractions of the same block name.
      const key = namespace + ':' + block + (wanted === null ? '' : '@' + wanted)
      const directory = await referenceDirectory(project)
      if (directory === '') {
        return { error: '还没有设置参考目录，取不到原版或模组的方块。在设置里指定 .minecraft 或版本目录。' }
      }
      const signature = await refSignatureOf(directory)
      const cached = referenceBlocks.get(key)
      if (cached !== undefined && cached.signature === signature) return cached
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) {
        return { error: '找不到 ' + EXTRACT_SCRIPT + '（从项目目录往上找了 5 层都没有）。' }
      }
      const blockArg = namespace + ':' + block
      const tokens = ['--root', directory, '--block', blockArg]
      if (wanted !== null) tokens.push('--variant', wanted)
      // 展示给人看的那条命令也按方言拼，免得用户拿去手跑时报"找不到命令"。
      // `-B` 和真跑的那条一样：别在随包的 `panel/python/` 边上留 .pyc。
      const dialect = await currentShell(project.dir)
      const command = pythonHint() + ' -B ' + dialect.word(extractor) + ' ' +
        tokens.map((token) => dialect.word(token)).join(' ')
      const parsed = await runScanner(extractor, tokens, 120000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        return { error: String(parsed === undefined ? '抽取脚本没有返回任何东西' : parsed.error) }
      }
      const refs = parsed.modelRefs || []
      if (refs.length === 0) return { error: '抽出来的方块没有可用的模型：' + key }
      const entry = {
        signature: signature, namespace: namespace, block: block,
        name: parsed.name || block, nameKey: parsed.nameKey, version: parsed.version,
        variant: parsed.variant === undefined ? null : parsed.variant,
        variantKeys: parsed.variantKeys || [],
        // The independent properties behind those keys.  Twelve
        // `conditional=<bool>,facing=<dir>` keys are two questions, not twelve;
        // the viewer needs the questions.
        variantAxes: parsed.variantAxes || [],
        // What each property falls back to when nothing can derive it.  Nothing
        // in the world says whether a command block is conditional, so that one
        // has to come from here or the composed key is incomplete.
        variantDefaults: parsed.variantDefaults || {},
        rotation: parsed.variantRotation === undefined ? null : parsed.variantRotation,
        // `multipart` arrives as one ref per `apply`, because each carries its
        // OWN x/y rotation (a wall is a post plus four sides at 0/90/180/270).
        // Folding them into one model would have to rotate one element list four
        // ways -- so they stay apart and `quadsOfEntry` rotates each.  For a
        // `variants` block this is just `[refs[0]]` and `[]`, i.e. the same
        // single-model path it has always taken.
        modelRef: refs[0], modelRefs: refs,
        modelRotations: parsed.modelRotations || [],
        // Parallel to `modelRefs`: the `when` clause that says when the game
        // would draw that apply.  Empty for a `variants` blockstate.
        whenList: parsed.multipartWhens || [],
        multipart: parsed.multipart === true,
        load: virtualLoad(namespace, parsed), command: command,
      }
      referenceBlocks.set(key, entry)
      return entry
    }

