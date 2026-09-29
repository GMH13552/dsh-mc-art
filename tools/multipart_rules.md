# multipart 的连接规则：量出来的，不是背出来的

这个文件是**测量记录**，不是设计文档。它回答一个问题：搭架子里的墙/栅栏/玻璃板，
到底该不该在某一面画侧板？现在 `tools/mcart_extract_block.py` 交的是"所有 `apply` 的并集"，
屏幕上写着"近似"——那里面的连接规则原本是**每个方块家族自己的 Java 代码**，
和 `facing`（第 58 条）是同一类问题。所以在动手之前先把规则读出来。

## 证据链（都可以重跑）

```
参考目录  /mnt/c/Users/GMH13/Release 2.8.3/.minecraft/versions/1.18.2-Forge_40.2.0
jar       1.18.2-Forge_40.2.0.jar        （类名被混淆：a.class / aaa$a.class）
版本 json 里有 client_mappings 的地址（Mojang 官方映射，1.14.4 起发布）：
  https://piston-data.mojang.com/v1/objects/a661c6a55a0600bd391bdbbd6827654c05b2109c/client.txt
工具      /usr/bin/javap 存在；cfr/procyon/vineflower 都没有（反编译只有 javap 可用）
```

译名（`client.txt` 里 `真名 -> 混淆名`，靠这张表才读得懂字节码）：

| 真名 | 混淆 | 真名 | 混淆 |
|---|---|---|---|
| `WallBlock` | `clo` | `CrossCollisionBlock` | `cfd` |
| `FenceBlock` | `cgc` | `PipeBlock` | `cin` |
| `IronBarsBlock` | `chf` | `FenceGateBlock` | `cgd` |
| `Block` | `cdq` | `BlockState` | `cov` |
| `BlockTags` | `ahy` | `Blocks` | `cdr` |
| `Direction` | `go` | `Fluids` | `diy` |
| `LeavesBlock` | `cho` | `WallSide` | `cqg`（`a`=NONE `b`=LOW `c`=TALL）|

读法（对每个方法）：

```bash
javap -p -c -cp 1.18.2-Forge_40.2.0.jar clo | sed -n '/private boolean a(cov, boolean, go);/,/^$/p'
# 再把 getstatic/invoke/instanceof 的 #常量 用 client.txt 翻译成人名
```

**自洽校验**：栅栏/玻璃板的四个属性在字节码里配的方向是
`NORTH`←`SOUTH`、`EAST`←`WEST`、`SOUTH`←`NORTH`、`WEST`←`EAST`，
正好是"从邻居朝我这边"的方向；如果映射读错一位，这个对称性立刻就崩。
方向常量的字母序由 `updateShape` 里 `.getFaceShape(go.a)` 与 `Direction.DOWN` 对上，
即 `a=DOWN b=UP c=NORTH d=SOUTH e=WEST f=EAST`（枚举声明顺序）。

## 一、例外表：`Block.isExceptionForConnection(BlockState)`

```java
block instanceof LeavesBlock
  || state.is(Blocks.BARRIER) || state.is(Blocks.CARVED_PUMPKIN) || state.is(Blocks.JACK_O_LANTERN)
  || state.is(Blocks.MELON)   || state.is(Blocks.PUMPKIN)       || state.is(BlockTags.SHULKER_BOXES)
```

`getstatic cdr.gB/dc/dd/dS/cS` 逐个翻出来就是上面这五个方块；`ahy.aE` = `SHULKER_BOXES`。
这些方块**不算"结实到能连"**（树叶/南瓜/潜影盒/屏障）。注意它只在
`!exception && isSideSolid` 那一支里起作用——`is(BlockTags.WALLS)` 那支不受影响。

## 二、三个家族的连接谓词（全部读自字节码）

```java
// WallBlock.connectsTo(state, isSideSolid, dir)   [clo: private boolean a(cov,Z,go)]
gate = (state.getBlock() instanceof FenceGateBlock) && FenceGateBlock.connectsToDirection(state, dir)
return state.is(BlockTags.WALLS)
    || (!isExceptionForConnection(state) && isSideSolid)
    || state.getBlock() instanceof IronBarsBlock
    || gate

// FenceBlock.connectsTo(state, isSideSolid, dir)  [cgc: public boolean a(cov,Z,go)]
gate = (state.getBlock() instanceof FenceGateBlock) && FenceGateBlock.connectsToDirection(state, dir)
return (!isExceptionForConnection(state) && isSideSolid) || isSameFence(state) || gate

// FenceBlock.isSameFence(state)                   [cgc: private boolean h(cov)]
return state.is(BlockTags.FENCES)
    && (state.is(BlockTags.WOODEN_FENCES) == this.defaultBlockState().is(BlockTags.WOODEN_FENCES))

// IronBarsBlock.attachsTo(state, isSideSolid)     [chf: public final boolean a(cov,Z)]
return (!isExceptionForConnection(state) && isSideSolid)
    || state.getBlock() instanceof IronBarsBlock
    || state.is(BlockTags.WALLS)

// FenceGateBlock.connectsToDirection(state, dir)  [cgd: public static boolean a(cov,go)]
return state.getValue(FACING).getAxis() == dir.getAxis();
```

三个要点，都是**数据里读不到、只能从代码里读**的：

1. **墙会连玻璃板，玻璃板会连墙**（`instanceof IronBarsBlock` / `is(BlockTags.WALLS)` 互相对称），
   但**栅栏不连墙**（`FenceBlock` 里没有 `WALLS` 这一支）。
2. **木栅栏只连木栅栏**：`isSameFence` 要求"都是/都不是 `WOODEN_FENCES`"，
   所以下界砖栅栏和木栅栏相邻**不连**。
3. **树叶/南瓜/潜影盒/屏障"结实"也不算**（例外表）——单看 `isSolid()` 会连错。

## 三、属性是怎么算出来的

### 栅栏 / 玻璃板（共享基类 `CrossCollisionBlock`）

```java
// getStateForPlacement / updateShape 里，对每个水平方向 D：
prop_D = connectsTo(stateAt(pos.relative(D)),
                    stateAt(pos.relative(D)).isFaceSturdy(level, pos.relative(D), D.getOpposite()),
                    D)
waterlogged = level.getFluidState(pos).getType() == Fluids.WATER
// updateShape 只在 D.getAxis().getPlane() == Plane.HORIZONTAL 时改属性，否则交给 super
```
（`CFD.<clinit>` 把 `PROPERTY_BY_DIRECTION` 从 `PipeBlock.PROPERTY_BY_DIRECTION` 里
按"水平轴"过滤出来，也就是**键=方向、值=同名属性**。）

### 墙（`WallBlock`）

```java
// 1.18.2 `WallBlock.updateShape(state, dir, neighbourState, level, pos, neighbourPos)`
//   dir==DOWN  -> super.updateShape
//   dir==UP    -> a(level, state, neighbourPos, neighbourState)
//                 这里 neighbourPos 就是 pos.above()，所以 aboveState 是**我上面那格**
//   否则       -> a(level, pos, state, neighbourPos, neighbourState, dir)

// 上面那一支 a(level,state,abovePos,aboveState)：
//   四个属性里只有"方向==正被更新的那个方向"的那一个重新算，其余沿用 state
aboveShape = aboveState.getCollisionShape(level, pos.above()).getFaceShape(Direction.DOWN);
state2 = updateSides(state, n, e, s, w, aboveShape);      // 四个侧面
return state2.setValue(UP, shouldRaisePost(state2, aboveState, aboveShape));

// updateSides: 每个方向 D 的 WallSide = makeWallState(isConnected(state, D_WALL), aboveShape, TEST_D)
// isConnected(state, prop) = state.getValue(prop) != WallSide.NONE
// makeWallState(isTall, sideShape, collideShape):
//     if (!isTall) NONE;  else (isCovered(sideShape, collideShape) ? TALL : LOW)
// isCovered(sideShape, collideShape) = !Shapes.joinIsNotEmpty(collideShape, sideShape, BooleanOp.ONLY_FIRST)
//                                    = collideShape ⊆ sideShape
//   代入调用处（sideShape=aboveShape，collideShape=TEST_D）：
//   **TALL ⟺ 这一侧的脚印整个落在"我上面那格的底面"里**，即**我**头上压着一个盖住它的方块。
//   （`aboveShape` 取自我自己上方那一格，不是邻居上方那一格——这一条第一版读错了，
//     2026-xx 重读 `clo` 时按 `updateShape` 的 `dir==UP` 分支改正。）

// shouldRaisePost(state, aboveState, aboveShape):     [clo: private boolean a(cov,cov,dqh)]
if (aboveState.getBlock() instanceof WallBlock && aboveState.getValue(UP)) return true;
N/S/E/W = state 的四个 WallSide；n0=(N==NONE) s0=(S==NONE) e0=(E==NONE) w0=(W==NONE)
asym = (n0&&s0&&e0&&w0) || (n0!=s0) || (e0!=w0)          // 注意：全是 NONE 也算
if (asym) return true;
tallPair = (N==TALL && S==TALL) || (E==TALL && W==TALL)
if (tallPair) return false;                              // ← 上下对这一条也要读准：
return aboveState.is(BlockTags.WALL_POST_OVERRIDE)       //    高的那一对是"不要柱子"
    || isCovered(aboveShape, POST_TEST);                 //    （POST_TEST = 中间 2x2 那根柱子的脚印）
```

最后两支的极性必须按字节码读：`0xed iload 14 / ifeq 242 / iconst_0 / ireturn` 是
"tallPair 为真 → 直接返回 false"，不是"tallPair 也算 raise"。第一版按印象写成
`asym || tallPair`，会让"四边都是 tall"的墙多画一根柱子。

墙的 `when` 面印证了这套规则：`prismarine_wall` 只有 `up: true` 和四个 `{low|tall}`，
**没有 `none`**。所以孤立一格墙：`updateSides` 四边都 NONE → `shouldRaisePost` 因
"全是 NONE" 为真 → `up=true` → 只画柱子，四个侧面因为 `when` 要 `low/tall` 而不画。

### `when` 面（从 jar 的 blockstate 直接读）

| 方块 | applies | `when` 出现的键 |
|---|---|---|
| `prismarine_wall` | 9 | `north/east/south/west` = {low,tall}，`up` = {true} |
| `mossy_cobblestone_wall` | 9 | 同上 |
| `oak_fence` | 5 | `north/east/south/west` = {true} |
| `glass_pane` / `white_stained_glass_pane` | 9 | 四个方向 = {false,true}（**有 false 那支**：没连上时画的 `noside`） |

栅栏只有 `true`、墙只有 `low|tall`，玻璃板两支都有——**过滤时不能假设"总有一支匹配"**。

## 四、我们的搭架子能提供什么

| 规则要的输入 | 我们有什么 | 怎么取 |
|---|---|---|
| 六个方向的邻居方块 id | 格子里有 | `cells` 里 `at+step` 那一格 |
| `isSideSolid`（邻居朝我的那一面是否结实） | 邻居的模型 | 邻居的 `elements` 里有没有覆盖 16³ 的整块（`[0,0,0]→[16,16,16]`），即"满方块" |
| `isExceptionForConnection` | 邻居 id | 上面第一节的表 + 标签（`SHULKER_BOXES` 等只有 id 不够时要读标签） |
| `WALLS/FENCES/WOODEN_FENCES` 成员 | jar 的 tag json | 已读：walls 21、fences 2（`#wooden_fences` + 下界砖）、wooden_fences 8 |
| `waterlogged` | 没有流体 | 当 `false`（并说明） |
| `FACING`（栅栏门的朝向） | 格子的 `variant` | 有朝向时就能算（`getAxis()` 相同即连） |

`isSideSolid` 这条尤其值得注意：它**不是"邻居存在就算"**，而是"邻居朝我的那一面结实"。
我们手上有模型，所以这是**可推的**而不是猜的：满方块模型 → 结实；台阶/楼梯/墙 → 那面不结实。

## 五、1.12.2（同一套办法，多一跳映射）

1.12.2 的 jar **全混淆**（连 `net/minecraft/...` 都没有），而且它的版本 json 里
**没有 `client_mappings`**——Mojang 是 1.14.4 才开始发的。所以走 MCP：

```
https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp/1.12.2/mcp-1.12.2-srg.zip        （joined.srg：混淆→SRG）
https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp_stable/39-1.12/mcp_stable-39-1.12.zip  （fields/methods.csv：SRG→MCP）
```
译名：`BlockFence aqo`、`BlockWall auv`、`BlockPane auo`、`Block aow`、`Blocks aox`、
`BlockFenceGate aqp`、`BlockFaceShape awr`（`a`=SOLID `b`=BOWL `c`=CENTER_SMALL
`d`=MIDDLE_POLE_THIN `e`=CENTER `f`=MIDDLE_POLE `g`=CENTER_BIG `h`=MIDDLE_POLE_THICK）。

**1.12.2 判连接靠的不是"面结实"，而是 `IBlockState.getBlockFaceShape(world,pos,side)`。**

```java
// 例外表（BlockFence 与 BlockWall 里各有一份，逐字节相同）
isExcep(block) = Block.isExceptBlockForAttachWithPiston(block)
              || block == Blocks.BARRIER || block == Blocks.MELON_BLOCK
              || block == Blocks.PUMPKIN || block == Blocks.LIT_PUMPKIN

// BlockFence.canConnectTo(world,pos,side)
face = state.getBlockFaceShape(world,pos,side); block = state.getBlock()
flag = (face == MIDDLE_POLE) && (state.getMaterial() == this.blockMaterial || block instanceof BlockFenceGate)
return (!isExcep(block) && face != SOLID) || flag

// BlockWall.canConnectTo
flag = (face == MIDDLE_POLE_THICK) || (face == MIDDLE_POLE && block instanceof BlockFenceGate)
return (!isExcep(block) && face != SOLID) || flag

// BlockPane.attachesTo
return (!isExcep(block) && face == SOLID) || face == MIDDLE_POLE_THIN
```

三个家族自己报告什么面形状（`getBlockFaceShape` 里的两个分支）：

| 家族 | 属性关 | 属性开 |
|---|---|---|
| `BlockFence` | `CENTER` | `MIDDLE_POLE` |
| `BlockWall` | `CENTER_BIG` | `MIDDLE_POLE_THICK` |
| `BlockPane` | `CENTER_SMALL` | `MIDDLE_POLE_THIN` |

于是能推出**高低版本真的不一样**的结论：

- 1.12.2 玻璃板**自己不往墙/栅栏那边长**（栅栏给 `CENTER/MIDDLE_POLE`、墙给
  `CENTER_BIG/MIDDLE_POLE_THICK`，都不是 `SOLID` 也不是 `MIDDLE_POLE_THIN`）；
  但**墙和栅栏会往玻璃板那边长**（玻璃板的面形状不是 `SOLID`，第一支就成立）——
  所以 1.12.2 的连接是**不对称的**，一句"玻璃板不连墙"会漏掉墙那一侧。
  1.18.2 里三种互相都连（`instanceof IronBarsBlock` 和 `is(BlockTags.WALLS)` 对称）。
- **1.12.2 连空气。** `Block.getBlockFaceShape` 默认 `SOLID`，而
  `BlockAir` 覆写成 **`UNDEFINED`**（`aom` 里 `getstatic awr.i; areturn`），
  `UNDEFINED != SOLID`，于是 `(!isExcep && face != SOLID)` 对空气成立：
  孤零零一根 1.12.2 墙/栅栏**四个侧面全都连**（`up` 因为 `flag` 为假而保持 true），
  只有玻璃板不连（它要 `face == SOLID` 才算，空气给的是 `UNDEFINED`）。
  1.18.2 里空气 `isSideSolid == false`、不在任何标签里 → 谁都不连，
  所以孤立一格是**光柱子**。**这就是"高低版本看起来不一样"最明显的一处。**
- 1.12.2 的判据粗得多：**"面不是 SOLID 就连"**，所以任何把 `getBlockFaceShape`
  覆写成非 SOLID 的方块（台阶、楼梯、树叶…）都会被连上，再靠例外表扣掉南瓜/西瓜那几种；
  1.18.2 是"面结实 + 标签 + 三个 `instanceof` + 例外表"，细得多。
  1.12.2 一共**只有 60 个类覆写了 `getBlockFaceShape`**（`javap -p` 整个 jar 后按
  `public awr a(amy, awt, et, fa)` 签名枚举得到；`Block` 自己那 60 个里绝大多数返回
  `UNDEFINED` 或"某几个面 SOLID"）。所以代理取"满方块=SOLID，其余=UNDEFINED"：
  侧向的面基本都对（台阶/楼梯/火把/箱子都返回 UNDEFINED → 连），
  只有"非满方块却对侧面返回 SOLID"的少数几种会连错，写在第六节里。
- 1.12.2 栅栏的"同材质"判据是 `state.getMaterial() == this.blockMaterial || instanceof BlockFenceGate`；
  1.18.2 是"都在/都不在 `WOODEN_FENCES`"。**所以下界砖栅栏和木栅栏在两边都不连，
  但原因不同**（1.12.2 靠材质，1.18.2 靠标签）。
- 1.12.2 里**墙和栅栏互相都连**（两者的面形状都不是 `SOLID`，第一支各自成立）；
  1.18.2 里**墙和栅栏互相都不连**：`FenceBlock.connectsTo` 里没有 `WALLS` 那一支，
  而栅栏既不结实也不在 `WALLS` 里，所以 `WallBlock.connectsTo` 对它也返回假。
  1.18.2 只有"墙 ↔ 玻璃板"这一对是**互相**连的（`instanceof IronBarsBlock` 与
  `is(BlockTags.WALLS)` 正好互为对方的一条分支）。一句话：1.18.2 是"三个家族各问各的"，
  1.12.2 是"谁的面不是满的就和谁连"。

**例外表（1.12.2，逐个字段读 `aox.<clinit>` 的 `ldc String` 得到，与本节顶部一致）**：

| 来源 | 成员 |
|---|---|
| `Block.isExceptionBlockForAttaching` | `BlockShulkerBox`、`BlockLeaves`、`BlockTrapDoor`、`beacon`、`cauldron`、`glass`、`glowstone`、`ice`、`lit_pumpkin`、`stained_glass`、`sea_lantern` |
| `Block.isExceptBlockForAttachWithPiston` | 上面那些 + `piston`、`sticky_piston`、`piston_head` |
| `BlockWall.e(block)`（墙自己再加的） | 上面那些 + `barrier`、`melon_block`、`pumpkin`、`lit_pumpkin` |

**`BlockFenceGate.getBlockFaceShape`（`aqp`，逐字节读）**：

```java
if (face == UP || face == DOWN) return UNDEFINED;
return state.getValue(FACING).getAxis() == face.getAxis() ? MIDDLE_POLE : UNDEFINED;
```

（所以栅栏门对侧面报 `MIDDLE_POLE` 还是 `UNDEFINED` **只看轴**，不看到底是哪一面——
我们比较轴就行，方向的正负号不影响结果。）

**属性形状也不同**（这是兼容的关键）：

| | 墙的侧面 | 墙的 `up` | 栅栏/玻璃板侧面 |
|---|---|---|---|
| 1.12.2 | 布尔 `true` | 布尔 `"true"` | 布尔 |
| 1.18.2 | `low` / `tall`（`WallSide`）| 布尔 | 布尔 |

**而且 1.12.2 **也用 `multipart`**（`cobblestone_wall.json` 就是 `{"multipart":[...]}`）——
抽取器里那句"1.13+ 的 multipart"是错的，这个功能对 1.12.2 同样有用。
另外同一个版本的 `when` 里**两种拼法混用**：墙写 `"up": "true"`（字符串），
玻璃板写 `"north": true`（布尔）。过滤时必须两种都认。

## 六、高低版本兼容怎么做

**规则按版本选，机制不按版本分。** 抽取器已经会回报 `parsed.version`
（`1.12.2-Forge_14.23.5.28641` / `1.18.2-Forge_40.2.0`），所以：

1. **过滤机制与版本无关**：永远由 blockstate 的 `when` 说了算。属性名/取值、
   是布尔还是 `low/tall`，都从数据里读，不写死。取值比较前 `String(...)` 一下，
   兼容 `"true"` 与 `true`。
2. **连接谓词按版本选一套**（`version` 里含 `1.12` 还是 `1.18`）：
   1.12.2 那套用"面形状"，1.18.2 那套用"面结实 + 标签"。
   两套都写在这个文件里，实现时照抄，不凭记忆。
3. **我们对邻居的代理要分版本说清**：两版都需要"邻居朝我这一面算什么"，
   而我们只有邻居的**模型**：
   - 满方块（`[0,0,0]→[16,16,16]` 的整块）→ 1.18.2 `isSideSolid = true`；
     1.12.2 `face = SOLID`。
   - 墙/栅栏/玻璃板 → 那一族的面形状由**它自己的属性**决定，而那个属性正是我们
     在算的东西（自底向上：先算邻居，再算自己）→ 可推。
   - **其余方块是两版真正的分歧点**：1.18.2 只有"结实"才算
     （台阶/楼梯/树叶都不结实）；1.12.2 的默认是 `SOLID`，只有覆写了
     `getBlockFaceShape` 的方块（台阶、楼梯…）才不算，而要精确知道"谁覆写了"
     就得逐个方块读 Java——**这一处要么接受代理（满方块=SOLID，其余按模型判断），
     要么按需补一张表**。会在屏幕上说明用了哪种。
4. `waterlogged`：两版都没有流体模型 → 当 `false`，并说明。

## 七、这一轮补读的（2026-xx，实现前重读）

- **1.18.2 `WallBlock` 的 `aboveShape` 取自我自己上面那一格**，不是邻居上面那一格。
  依据是 `updateShape` 的三条分支（`clo.a(cov,go,cov,caw,gj,gj)`）：
  `dir==UP` 时调用 `a(level, state, neighbourPos, neighbourState)`，而 `dir==UP`
  时 `neighbourPos == pos.above()`。第一版按"邻居上面"实现，`tall` 会整片错位。
- **`shouldRaisePost` 的最后两支极性**：`tallPair` 为真 → `return false`。
  见第三节的字节码摘录。
- **1.12.2 `BlockWall.getActualState`(`auv.d(cov,amy,gj)`) 已读完**（未过滤）：
  四条 `canConnectTo(world, pos.<dir>(), <dir>.getOpposite())`，分别落到
  `NORTH/EAST/SOUTH/WEST` 属性，再算 `flag` 与 `up`。属性→字段对应关系是
  `a=UP b=EAST c=NORTH d=SOUTH e=WEST`（从 `d()` 里 `getstatic` 的顺序与
  `fa`/`et` 的映射定出来），所以"方向传入的是**从邻居朝我**"这一条自洽性检查成立。
- **1.12.2 `BlockAir.getBlockFaceShape = UNDEFINED`**，所以墙/栅栏连空气（见第五节）。
- **1.12.2 只有 60 个类覆写 `getBlockFaceShape`**；`Block` 默认 `SOLID`。
- 依旧没读的：`BlockPane`/`BlockFence` 的 `getBlockFaceShape` 逐行条件（只按
  "属性关→CENTER 系、属性开→MIDDLE_POLE 系"用过）；`WALL_POST_OVERRIDE` 这个标签
  的成员（我们只代理"上面压着满方块"，所以墙上的火把/告示牌会少一根柱子）。

## 八、实现顺序（都按这份规则来）

1. 抽取器（热更新）：把每个 `apply` 的 `when` 跟 `modelRefs` 平行发出来。**做完了**，
   `multipartWhens` 与 `modelRefs` 一一对应，57 个 pytest 通过。
2. 宿主：格子循环里按上面的谓词算出四个方向 + `up`，**只画 `when` 匹配的 apply**；
   推不出来的键不参与过滤（fail-open）；格子缓存键要带上邻居签名。**做完了**，
   见 `host.js` 的 `entryFamily`/`connectsTo`/`multipartValues`/`whenMatches`。
3. 幽灵预览：客户端把六个方向的邻居一起发过去，预览才能与落地后一致。**做完了**
   （`atlas.preview` 的 `around`）。
4. 屏幕上写清楚用到哪几条：`邻居：墙(sides 3/4, up)`，而不是笼统的"近似"。**做完了**，
   出的是 `multipart：N 个格子按邻居推导，只画原版会画的那部分`；`other` 家族
   （认不出是墙/栅栏/玻璃板的 multipart）**不参与过滤**并保留"全部画上"的说法。
5. 门禁：`tools/mcart-plugin/multipart-test.js`——孤立墙 / 一圈邻居 / 上面加高 /
   木栅栏贴下界砖栅栏（不该连）/ 墙贴玻璃板（该连）/ 1.12.2 与 1.18.2 的同一场景
   必须给出**不同**答案。
