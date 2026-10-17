    // What the connection rules need to know about one neighbour.  Everything
    // here is a property of the BLOCK, never of its own connection state, which
    // is why this is not recursive: the game's `isSideSolid` and
    // `getBlockFaceShape` are static answers about the neighbour, not "does the
    // neighbour connect back".
    function describeEntry(load, entry, id, variant) {
      if (entry === null || entry === undefined) return null
      if (entry.cubeMemo === undefined) entry.cubeMemo = isFullCubeEntry(load, entry)
      return { id: id, family: entryFamily(entry, id), cube: entry.cubeMemo === true,
        variant: variant === undefined ? null : variant,
        version: entry.version === undefined ? null : entry.version }
    }

    function neatKey(at) {
      return at[0] + ',' + at[1] + ',' + at[2]
    }


    // All the geometry one extracted entry contributes.
    //
    // A `variants` entry is ONE ref and rotates as a whole, which is all this
    // ever had to do.  A `multipart` entry is one ref per `apply` and each
    // carries its OWN x/y -- `prismarine_wall` is the post plus four sides at
    // 0/90/180/270 -- so they are rotated one at a time and then the union is
    // handed to the blockstate-level rotation, which stays LAST because the
    // element's own rotation is in model space and the variant's is in block
    // space.  Rotating them in the other order is the bug `faceAfter` documents.
    //
    // `keep`, when given, is one flag per ref: the game would not draw the
    // others HERE, because a neighbour decides (see `multipartValues`).  A kept
    // ref that cannot be resolved is still reported -- but a skipped one is not
    // "missing", so it is not reported either.
    function quadsOfEntry(load, entry, report, keep) {
      const refs = Array.isArray(entry.modelRefs) && entry.modelRefs.length > 0
        ? entry.modelRefs : [entry.modelRef]
      const rotations = Array.isArray(entry.modelRotations) ? entry.modelRotations : []
      let out = []
      const missed = []
      for (let index = 0; index < refs.length; index++) {
        if (keep !== undefined && keep[index] !== true) continue
        const elements = elementsOf(load, refs[index])
        if (elements === undefined) { missed.push(refs[index]); continue }
        const own = index < rotations.length ? rotations[index] : null
        out = out.concat(rotateQuads(quadsFromElements(elements, report), own))
      }
      if (out.length === 0) return undefined
      // Not fatal -- three of a wall's four sides still draw -- but it must not
      // be silent either: a missing piece looks like a modelling mistake.
      if (missed.length > 0 && report !== undefined) report('模型链里缺了：' + missed.join('、'))
      return rotateQuads(out, entry.rotation)
    }

    // One block, at one coordinate -- what the viewer draws as the translucent
    // "about to place here" ghost.  It goes through the same lookup the cells
    // do, so the ghost cannot disagree with what will actually appear.
    //
    // `around` is what makes that true for a wall: the ghost of a wall dropped
    // next to three existing walls must show the same shape the placed block
    // will have, so the caller sends the neighbours it can see, as
    // `[{ d: [dx,dy,dz], block: 'ns:name', variant? }]` offsets from `at`.
    async function blockQuadsAt(root, project, block, at, variant, around) {
      const found = await entryFor(root, project, String(block), variant)
      if (found.error !== undefined) {
        // The old message names the missing model; keep it, because the viewer
        // shows it verbatim next to the brush.
        return { error: found.error.indexOf('方块名是空的') >= 0
          ? found.error : '找不到 ' + String(block) + ' 的模型（' + found.error + '）' }
      }
      const load = found.load
      const entry = found.entry
      let keep
      if (entry.multipart === true) {
        const whens = Array.isArray(entry.whenList) ? entry.whenList : []
        const refs = Array.isArray(entry.modelRefs) ? entry.modelRefs : []
        const family = entryFamily(entry, found.id)
        if (whens.length > 0 && whens.length === refs.length && family !== 'other') {
          const id = found.id
          // Neighbours are resolved one by one and CACHED by `referenceLoad`,
          // so a ghost dragged over a wall does not re-extract the world: the
          // scene already extracted every one of them.
          const known = new Map()
          for (const item of Array.isArray(around) ? around : []) {
            if (item === null || typeof item !== 'object') continue
            if (!Array.isArray(item.d) || item.d.length < 3) continue
            if (typeof item.block !== 'string' || item.block === '') continue
            const offset = [Math.trunc(item.d[0]), Math.trunc(item.d[1]), Math.trunc(item.d[2])]
            const other = await entryFor(root, project, item.block,
              typeof item.variant === 'string' && item.variant !== '' ? item.variant : null)
            if (other.error !== undefined) continue
            const colon = item.block.indexOf(':')
            const otherId = colon >= 0 ? item.block : project.namespace + ':' + item.block
            known.set(neatKey(offset), describeEntry(other.load, other.entry, otherId,
              typeof item.variant === 'string' && item.variant !== '' ? item.variant : null))
          }
          const self = { id: id, family: entryFamily(entry, id), whens: whens, wooden: fenceWooden(id) }
          const values = multipartValues(entry.version, self,
            (dx, dy, dz) => known.get(neatKey([dx, dy, dz])) || null)
          keep = keepFlags(entry, values)
        }
      }
      // The rotation goes on LAST, after the element rotations inside
      // `quadsFromElements` -- see `quadsOfEntry`.
      const quads = quadsOfEntry(load, entry, note, keep)
      if (quads === undefined) return { error: '找不到 ' + String(block) + ' 的模型' }
      // 幽灵预览同样是取景框：**推导出来**的空结果（multipart 条件全不成立）是正常答案，
      // 但整条链一个面都解不出来时必须说一句，不能给一块空白板。
      if (quads.length === 0 && keep === undefined) {
        return { error: '找不到 ' + String(block) + ' 的模型（整条模型链一个面都解不出来，'
          + '通常是贴图在项目包里没有、参考目录也没取到）' }
      }
      // Two things the viewer needs and only the extraction has: the 朝向
      // choices, and whether the ghost itself is a block that a neighbour
      // decides (so it can say "按邻居" next to it).
      const axes = Array.isArray(entry.variantAxes) ? entry.variantAxes : []
      return { quads: translateQuads(quads, at),
        variants: entry.variantKeys || [], axes: axes, defaults: entry.variantDefaults || {},
        variant: entry.rotation === null || entry.rotation === undefined ? null : variant,
        multipart: entry.multipart === true, derived: keep !== undefined && keep !== null }
    }

