    async function itemIcon(namespace, parsed, have, project) {
      const load = virtualLoad(namespace, parsed)
      // 每个字段都要**有值**：宿主返回值里只要有一个 `undefined`，运行时就整条拒收
      // （见 `missingItemIcon` 的注释）。抽取器漏字段时给等价的空值，不给 undefined。
      const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
      const safe = (value) => (value === undefined ? null : value)
      const out = {
        namespace: namespace, item: text(parsed.item, ''),
        name: text(parsed.name, text(parsed.item, '')),
        shape: text(parsed.shape, 'none'), light: safe(parsed.light), display: parsed.display || null,
        form: safe(parsed.form), family: safe(parsed.family), formLabel: safe(parsed.formLabel),
        named: parsed.named === true,
        layers: [], frames: [], framesTruncated: parsed.framesTruncated === true,
        quads: [], error: typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : null,
        // Vanilla parents a project pack does not ship.  Surfaced because a
        // legacy `builtin/generated` (1.12.2's name for `item/generated`) is
        // worth telling the pack author about rather than hiding.
        missingModels: Array.isArray(parsed.missingModels) ? parsed.missingModels : [],
      }
      const ids = []
      const add = (id) => { if (ids.indexOf(id) < 0) ids.push(id) }
      if (parsed.shape === 'iso') {
        // Same geometry path as a block: one ref, its own rotations, then the
        // item's GUI matrix on top -- which the CLIENT applies, because the
        // icon's rotation order and lighting are GUI-specific and the rasteriser
        // lives there.
        const entry = { modelRef: parsed.modelRef || (parsed.modelRefs || [])[0] || null,
          modelRefs: parsed.modelRefs || [], modelRotations: parsed.modelRotations || [],
          rotation: parsed.variantRotation === undefined ? null : parsed.variantRotation,
          multipart: false, whenList: [] }
        const quads = quadsOfEntry(load, entry, note)
        out.quads = quads === undefined ? [] : quads
        for (const quad of out.quads) add(quad.tex)
      } else {
        out.layers = (parsed.layers || []).map((reference) => itemHandle(namespace, reference))
        for (const frame of parsed.frames || []) {
          out.frames.push({ predicate: frame.predicate || {},
            layers: (frame.layers || []).map((reference) => itemHandle(namespace, reference)) })
        }
        for (const id of out.layers) add(id)
        for (const frame of out.frames) for (const id of frame.layers) add(id)
      }
      out.textureIds = ids
      // The two files an item needs to name: its model (what "@ 提意见" points at,
      // the thing that decides whether the icon is a sprite or geometry) and, for
      // every texture that lives in this project's pack, the path the pen writes.
      out.modelPath = ''
      if (project !== undefined) {
        const model = project.dir + '/pack/assets/' + namespace + '/models/item/' + parsed.item + '.json'
        if ((await statOf(model)) !== undefined) out.modelPath = rel(project.root, model)
      }
      const layerRefs = (parsed.layers || []).concat(
        (parsed.frames || []).reduce((all, frame) => all.concat(frame.layers || []), []))
      for (const reference of layerRefs) {
        const file = (parsed.textureFiles || {})[reference]
        if (typeof file !== 'string' || file === '') continue
        const full = project === undefined ? undefined : project.dir + '/pack/' + file
        if (full === undefined || (await statOf(full)) === undefined) continue
        editablePaths.set(itemHandle(namespace, reference), full)
      }
      const already = {}
      if (Array.isArray(have)) for (const path of have) already[path] = true
      const textures = {}
      for (const id of ids) {
        if (already[id] === true) continue
        const url = await textureUrlFor(id, project)
        if (url !== undefined) textures[id] = url
      }
      out.textures = textures
      out.animations = animationsFor(ids)
      out.animationNotes = animationNotesFor(ids)
      return out
    }

    async function itemFactsList(project, namespace, source) {
      const resolved = await itemRoots(project, source)
      if (resolved.error !== undefined) return { error: resolved.error }
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
      const parsed = await runScanner(extractor,
        rootArgs(resolved.roots).concat(['--list', '--namespace', namespace, '--kind', 'item']),
        180000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
      }
      return { namespace: namespace, version: parsed.version, items: parsed.items || [] }
    }

    async function itemIconPage(project, namespace, items, source) {
      const resolved = await itemRoots(project, source)
      if (resolved.error !== undefined) return { error: resolved.error }
      const extractor = await findTool(project.dir, EXTRACT_SCRIPT)
      if (extractor === null || extractor === undefined) return { error: '找不到 ' + EXTRACT_SCRIPT }
      // ONE process for the page: a single item spends almost all of its time
      // opening every jar, so forty processes would make the picker unusable.
      const parsed = await runScanner(extractor,
        rootArgs(resolved.roots).concat(['--items', items.join(','), '--namespace', namespace]),
        180000, project.dir, REFERENCE_MAX_BYTES)
      if (parsed === undefined || parsed.error !== undefined) {
        return { error: String(parsed === undefined ? '没有返回任何东西' : parsed.error) }
      }
      const out = {}
      for (const item of Object.keys(parsed.items || {})) {
        const entry = parsed.items[item]
        // 一格坏掉不许拖垮整页：坏格给显式标记，其余照常。
        const reason = itemEntryProblem(namespace, item, entry)
        if (reason !== null) {
          out[item] = missingItemIcon(namespace, item, reason)
          continue
        }
        try {
          out[item] = await itemIcon(namespace, entry, [], project)
        } catch (error) {
          // 一个物品的渲染抛异常也一样：只空它这一格，把原因写在格子上。
          out[item] = missingItemIcon(namespace, item,
            '画这个物品的图标时出错：' + String(error && error.message ? error.message : error))
        }
      }
      return { namespace: namespace, version: parsed.version, items: out }
    }

