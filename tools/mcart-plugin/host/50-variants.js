    // ---- which `apply` the game would draw --------------------------------
    //
    // A wall/fence/pane blockstate lists every piece it COULD show, one `when`
    // clause each, and the game evaluates those clauses against the NEIGHBOURS.
    // A structure is a grid of cells, so we have the neighbours -- which means
    // the union can be replaced by what the game would actually draw.
    //
    // The rules below were READ OUT OF THE GAME'S OWN BYTECODE, one version at a
    // time, never recalled: `tools/multipart_rules.md` has the evidence, the
    // class and method names, and the reproduction commands.  1.18.2 asks
    // whether the neighbour's face toward us is sturdy, plus block tags and
    // three `instanceof`; 1.12.2 asks which `BlockFaceShape` the neighbour
    // reports, which is a property of its FAMILY alone.  Both need only two
    // things about a neighbour -- is it a full cube, which family is it -- and
    // the family is visible in the pack's own `when` clauses, so no table of
    // block names is involved beyond the two exception lists, which are
    // block-name lists in the game as well.
    function entryFamily(entry, id) {
      if (entry === undefined || entry === null) return 'other'
      const axes = Array.isArray(entry.variantAxes) ? entry.variantAxes : []
      // A fence gate is a `variants` blockstate, not multipart, and the game
      // asks about it with `instanceof FenceGateBlock`.  Its own property list
      // names it: `in_wall` belongs to gates and to nothing else in the game.
      for (const axis of axes) {
        if (axis !== null && typeof axis === 'object' && axis.name === 'in_wall') return 'gate'
      }
      if (entry.multipart !== true) return 'other'
      const whens = Array.isArray(entry.whenList) ? entry.whenList : []
      let sawUp = false
      let sawFalse = false
      let sawTrue = false
      for (const when of whens) {
        for (const key of Object.keys(when)) {
          if (key === 'up') { sawUp = true; continue }
          if (key !== 'north' && key !== 'east' && key !== 'south' && key !== 'west') continue
          if (when[key] === 'false') sawFalse = true
          else sawTrue = true
        }
      }
      // Measured shapes: walls carry `up` (1.12.2 and 1.18.2 alike); panes have
      // applies for the "no side here" case (`false`); fences only ever draw a
      // side when it connects (`true`).
      let shape = 'other'
      if (sawUp) shape = 'wall'
      else if (sawFalse) shape = 'pane'
      else if (sawTrue) shape = 'fence'
      if (shape === 'other') return 'other'
      // The shape alone is not enough.  `redstone_wire`, `tripwire` and
      // `chorus_plant` are multipart with the same four side keys, and the game
      // decides what a wall connects to with BLOCK TAGS (`BlockTags.WALLS`,
      // `FENCES`, `WOODEN_FENCES`) and `instanceof`, not with a shape.  A tag is
      // data, and a resource pack does not carry it -- but block names follow
      // the convention, so the NAME is asked too and a mismatch is refused
      // rather than guessed.  A mod's wall that is not called `*_wall` therefore
      // draws its union instead of a wrong subset -- see `keepFlags`' caller.
      const text = String(id === undefined || id === null ? '' : id)
      const name = text.slice(text.indexOf(':') + 1)
      if (shape === 'wall') return /(^|_)wall$/.test(name) ? 'wall' : 'other'
      if (shape === 'fence') return /(^|_)fence$/.test(name) ? 'fence' : 'other'
      return (/(^|_)pane$/.test(name) || /(^|_)bars$/.test(name)) ? 'pane' : 'other'
    }

    function isFullCubeEntry(load, entry) {
      const refs = Array.isArray(entry.modelRefs) && entry.modelRefs.length > 0
        ? entry.modelRefs : [entry.modelRef]
      const elements = elementsOf(load, refs[0])
      if (!Array.isArray(elements) || elements.length !== 1) return false
      const element = elements[0]
      if (element === undefined || element.rotation !== undefined) return false
      const from = element.from
      const to = element.to
      if (!Array.isArray(from) || !Array.isArray(to)) return false
      return from[0] === 0 && from[1] === 0 && from[2] === 0
        && to[0] === 16 && to[1] === 16 && to[2] === 16
    }

    // The only two block-name lists in either rule -- and in the game they are
    // block-name lists too: no data asks "is this leaves".  Read per version.
    const EXCEPT_18 = { barrier: 1, carved_pumpkin: 1, jack_o_lantern: 1, melon: 1, pumpkin: 1 }
    function isException18(id) {
      const text = String(id)
      const name = text.slice(text.indexOf(':') + 1)
      if (EXCEPT_18[name] === 1) return true
      if (/_leaves$/.test(name)) return true                       // LeavesBlock
      return name === 'shulker_box' || /_shulker_box$/.test(name)  // BlockTags.SHULKER_BOXES
    }
    const EXCEPT_12 = { beacon: 1, cauldron: 1, glass: 1, glowstone: 1, ice: 1, sea_lantern: 1,
      stained_glass: 1, piston: 1, sticky_piston: 1, piston_head: 1, barrier: 1,
      melon_block: 1, pumpkin: 1, lit_pumpkin: 1 }
    function isException12(id) {
      const text = String(id)
      const name = text.slice(text.indexOf(':') + 1)
      if (EXCEPT_12[name] === 1) return true
      if (/_leaves$/.test(name)) return true                        // BlockLeaves
      if (/_trapdoor$/.test(name)) return true                      // BlockTrapDoor
      if (/_stained_glass$/.test(name)) return true                 // BlockStainedGlass
      return name === 'shulker_box' || /_shulker_box$/.test(name)   // BlockShulkerBox
    }

    function isOldVersion(version) {
      const text = String(version === undefined || version === null ? '' : version)
      return text.indexOf('1.12') >= 0 || text.indexOf('1.11') >= 0 || text.indexOf('1.10') >= 0
    }

    function axisOfDirection(name) {
      if (name === 'north' || name === 'south') return 'z'
      if (name === 'east' || name === 'west') return 'x'
      return 'y'
    }

    function variantValueOf(variant, name) {
      if (typeof variant !== 'string' || variant === '') return null
      const parts = variant.split(',')
      for (const part of parts) {
        const at = part.indexOf('=')
        if (at > 0 && part.slice(0, at) === name) return part.slice(at + 1)
      }
      return null
    }

    // Does OUR block connect to THAT neighbour on THAT side?  `dir` is the
    // direction from the neighbour toward us -- measured, not assumed:
    // `BlockWall.getActualState` reads the NORTH property from
    // `canConnectTo(world, pos.north(), EnumFacing.SOUTH)`, and the same
    // opposite-direction pairing holds for all four sides.  It is consulted for
    // one thing only, a fence gate, and there only its AXIS is compared; so the
    // sign cannot matter.  That is worth saying out loud, because a sign error
    // would flip every gate while leaving every other piece correct.
    //
    // `neighbour === null` means AIR, and air is NOT "no neighbour": in 1.12.2
    // `BlockAir.getBlockFaceShape` returns UNDEFINED, which is `!= SOLID`, so a
    // wall or a fence connects to the empty air beside it.  That is why a lone
    // 1.12.2 wall shows its four arms and a lone 1.18.2 wall shows only a post.
    function connectsTo(version, self, neighbour, dir) {
      const absent = neighbour === null || neighbour === undefined
      if (isOldVersion(version)) {
        // 1.12.2: the neighbour reports a BlockFaceShape, and that depends only
        // on its FAMILY -- `getBlockFaceShape` says nothing about the
        // neighbour's own connection state, so this is not recursive.  Every
        // block that does not override it reports SOLID; `Block` is the default
        // and that is the measured base.  The families that DO override it
        // report their own shape.  Everything else is proxied as "a full cube
        // reports SOLID, anything else reports UNDEFINED", which is what the
        // overriders actually do for a face pointing sideways.
        let face = 'undefined'
        if (!absent) {
          if (neighbour.family === 'wall') face = 'poleThick'
          else if (neighbour.family === 'fence') face = 'pole'
          else if (neighbour.family === 'pane') face = 'poleThin'
          else if (neighbour.family !== 'gate') face = neighbour.cube === true ? 'solid' : 'undefined'
          else if (!gateAlongAxis(neighbour, dir)) face = 'undefined'
          else face = 'pole'
        }
        const exception = absent ? false : isException12(neighbour.id)
        if (self.family === 'pane') return (!exception && face === 'solid') || face === 'poleThin'
        // BlockFence:  (!isExcep && face != SOLID) || (face == MIDDLE_POLE && ...)
        // BlockWall:   (!isExcep && face != SOLID) || face == MIDDLE_POLE_THICK
        // Both are "not SOLID" first, so a 1.12.2 wall and a 1.12.2 fence DO
        // meet -- the 1.18.2 split between them is a later rewrite.
        const flag = face === (self.family === 'wall' ? 'poleThick' : 'pole')
        return (!exception && face !== 'solid') || flag
      }
      if (absent) return false
      const exception = isException18(neighbour.id)
      const solid = neighbour.cube === true && !exception
      if (neighbour.family === 'gate') {
        // `FenceGateBlock.connectsToDirection`: a gate connects along its own
        // axis, and the cell's `variant` is where its orientation lives.
        return gateAlongAxis(neighbour, dir)
      }
      if (self.family === 'wall') {
        return neighbour.family === 'wall' || solid || neighbour.family === 'pane'
      }
      if (self.family === 'fence') {
        return solid || (neighbour.family === 'fence' && self.wooden === fenceWooden(neighbour.id))
      }
      if (self.family === 'pane') {
        // No gate branch here: measured, `IronBarsBlock.attachsTo` does not ask
        // about gates at all, so a pane really does not meet a gate.
        return solid || neighbour.family === 'pane' || neighbour.family === 'wall'
      }
      return false
    }

    // A cell with no orientation cannot be derived, and the policy is to draw
    // one piece too many rather than a hole -- so an unknown facing counts as
    // "along our axis".  Measured: `BlockFenceGate.getBlockFaceShape` returns
    // MIDDLE_POLE when `FACING.getAxis() == face.getAxis()`, UNDEFINED
    // otherwise, and UNDEFINED for up/down.
    function gateAlongAxis(neighbour, dir) {
      const facing = variantValueOf(neighbour.variant, 'facing')
      return facing === null || axisOfDirection(facing) === axisOfDirection(dir)
    }

    // The property values the game would compute for this cell's block.  Every
    // value is a STRING, because that is what a `when` clause compares against.
    // `at(dx, dy, dz)` -> { id, family, cube, variant } | null.
    function multipartValues(version, self, at) {
      const names = []
      for (const when of self.whens) {
        for (const key of Object.keys(when)) if (names.indexOf(key) < 0) names.push(key)
      }
      const back = { north: 'south', south: 'north', east: 'west', west: 'east' }
      const steps = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] }
      const sides = {}
      for (const name of Object.keys(steps)) {
        const step = steps[name]
        sides[name] = connectsTo(version, self, at(step[0], 0, step[2]), back[name])
      }
      const v12 = isOldVersion(version)
      const values = {}
      for (const name of Object.keys(sides)) {
        if (names.indexOf(name) < 0) continue
        if (self.family === 'wall' && !v12) {
          // 1.18.2 walls: `low`/`tall`.  `updateSides` builds each side with
          // `makeWallState(isConnected, aboveShape, TEST_D)`, and
          // `isCovered(sideShape, collideShape) = collideShape ⊆ sideShape`.
          // The `aboveShape` there comes from `level.getBlockState(pos.above())`
          // -- the block above ME, not above the neighbour -- so `tall` means
          // "the block on top of ME covers this side's footprint".  Proxied as
          // "the block above me is a full cube", which is what covers it.
          const over = at(0, 1, 0)
          const covered = over !== null && over.cube === true
          values[name] = sides[name] ? (covered ? 'tall' : 'low') : 'none'
        } else {
          values[name] = sides[name] ? 'true' : 'false'
        }
      }
      if (names.indexOf('up') < 0) return values
      const above = at(0, 1, 0)
      if (self.family === 'wall' && v12) {
        // 1.12.2: `up = flag ? !isAirBlock(pos.up()) : true`, with
        // `flag = (N && !W && S && W..)` read from `BlockWall.getActualState`.
        // Note that in 1.12.2 AIR ITSELF CONNECTS (BlockAir reports UNDEFINED,
        // which is `!= SOLID`), so a lone wall has all four sides connected and
        // the flag is false -> the post stays.  The flag is only true in the
        // measured narrow case of a wall between two full blocks with nothing
        // solid east or west.
        const flag = (sides.south && !sides.west && sides.north && sides.east)
          || (!sides.south && sides.west && !sides.north && sides.east)
        values.up = flag ? (above === null ? 'false' : 'true') : 'true'
        return values
      }
      // 1.18.2: `shouldRaisePost`, read from `clo.a(cov,cov,dqh)`.  Its first
      // branch asks about the block ABOVE being a wall whose own `up` is true;
      // we approximate that with "is a wall" and say so -- the fully recursive
      // version would have to walk the column.
      let raise = above !== null && above.family === 'wall'
      if (!raise) {
        const none = (name) => values[name] === undefined || values[name] === 'none'
        const asym = (none('north') && none('south') && none('east') && none('west'))
          || (none('north') !== none('south')) || (none('east') !== none('west'))
        const tallPair = (values.north === 'tall' && values.south === 'tall')
          || (values.east === 'tall' && values.west === 'tall')
        // Measured order: asymmetric -> post; a tall run -> NO post; otherwise
        // the post depends on what is above -- `aboveState.is(WALL_POST_OVERRIDE)`
        // or `isCovered(aboveShape, POST_TEST)`, i.e. "a block on top holding
        // the post down".  The proxy is a full cube above me; a torch or sign
        // (the tag half) is not covered by it and will miss a post.
        if (asym) raise = true
        else if (tallPair) raise = false
        else raise = above !== null && above.cube === true
      }
      values.up = raise ? 'true' : 'false'
      return values
    }

    // Fail-open on purpose: a key we cannot derive must not silently delete a
    // piece of the model.  Drawing one piece too many is visible and fixable;
    // drawing none is a hole that looks like a modelling mistake.
    function whenMatches(when, values) {
      for (const key of Object.keys(when)) {
        const have = values[key]
        if (have === undefined) continue
        if (String(have) !== String(when[key])) return false
      }
      return true
    }

    // The only fence whose wooden-ness differs from the rest of vanilla.  The
    // game asks a TAG (`WOODEN_FENCES`), and a tag is not in a resource pack --
    // a mod's fence will be classified wooden here -- but getting vanilla right
    // is what the 1.18.2 `isSameFence` rule needs, and 1.12.2 does not ask at
    // all.  Said plainly rather than guessed at silently.
    function fenceWooden(id) {
      const text = String(id)
      return !/nether_brick_fence$/.test(text.slice(text.indexOf(':') + 1))
    }

    // The `keep` flags for one multipart entry sitting among these neighbours.
    // Returns undefined when the entry is not multipart, or when its `when`
    // clauses do not line up with its refs, or when a key they ask about could
    // not be derived at all -- in those cases the union stands, because guessing
    // which clause belongs to which piece would be worse.
    function keepFlags(entry, values) {
      const whens = Array.isArray(entry.whenList) ? entry.whenList : []
      const refs = Array.isArray(entry.modelRefs) ? entry.modelRefs : []
      if (entry.multipart !== true || whens.length !== refs.length || refs.length === 0) return undefined
      for (const when of whens) {
        for (const key of Object.keys(when)) {
          if (values[key] === undefined) return undefined
        }
      }
      // "Every flag false" is NOT a failure.  A 1.12.2 wall walled in by solid
      // blocks on all four sides, with a block above it, really does draw
      // nothing -- the game hides the whole thing.  Reading that as "we could
      // not decide" would put a post where the game leaves a hole.
      return whens.map((when) => whenMatches(when, values))
    }

    // One block name -> a loaded entry, whether it lives in the open project's
    // own pack or has to be pulled out of the reference jars.  The cell
    // renderer, the ghost and the neighbour lookup all need that answer, and
    // three copies of it is three places for the namespace fallback to drift.
    async function entryFor(root, project, reference, variant) {
      const colon = reference.indexOf(':')
      const namespace = colon >= 0 ? reference.slice(0, colon) : project.namespace
      const name = colon >= 0 ? reference.slice(colon + 1) : reference
      if (name === '') return { error: '方块名是空的' }
      const load = await ensure(namespace)
      if (load !== undefined) {
        return { load: load, id: namespace + ':' + name,
          entry: { modelRef: 'block/' + name, rotation: null, multipart: false, version: null } }
      }
      const ref = await referenceLoad(root, project, namespace, name, variant)
      if (ref.error !== undefined) return { error: ref.error }
      return { load: ref.load, id: ref.namespace + ':' + ref.block, entry: ref }
    }

