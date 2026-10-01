# Example Land · 模组工程（Forge 1.18.2）

这个目录是**代码那一半**。资源那一半在 `../pack/`（`examplemod/pack/`），由面板和
`mc-art` skill 编辑，`../mc-art.atlas.json` 是它的索引。

## 为什么不在这里放资源

同一个命名空间有两份 `assets/examplemod/` 就是两个真相，迟早对不上。所以：

- `../pack/` = 资源**唯一**真相（贴图、模型、blockstate、lang）；
- 这里 = **代码**，外加以后由 `datagen` 从 atlas **生成**到
  `src/generated/resources/` 的那一份（生成物，不是手写物）。

现在这个模组故意**一个资源都没有**：`GameTestServer` 不渲染画面，裁判只判行为。

## 跑裁判

```bash
# 推荐：走判定工具（读退出码、解析日志、给出裁决；--fault 证明裁判会说"不"）
# Windows 上解释器通常叫 python（`python3` 常是 0 字节 Store 存根）
python ../../tools/mcmod_gametest.py
python ../../tools/mcmod_gametest.py --fault

# 或者直接：
./gradlew runGameTestServer --no-daemon --console=plain
```

**实测结果**（1.18.2 / Forge 40.2.0）：

| 跑法 | 服务端说 | 退出码 |
|---|---|---|
| 正常 | `All 2 required tests passed :)` | 0 |
| `--fault`（断言改成 DIRT） | `exampleBlockPlaces failed! 放下去的示例方块不是示例方块 at 1,-59,1 (relative: 1,1,1)` + `1 required tests failed :(` | 1 |

首次构建 26 分钟（下 Gradle 发行版 + MC/Forge 依赖 + 450 MB 资源，走代理），之后每次 **约 1 分钟**。

- 它起的是 Mojang 的 `GameTestServer`：**无窗口**、跑完就退、**退出码 = 失败的必要测试数量**。
- 测试写在 `src/main/java/com/examplemod/ExampleGameTests.java`，用
  `GameTestHelper` 断言（`setBlock` / `assertBlockState` / `assertTrue`），
  注册走 `RegisterGameTestsEvent`（Forge 自己 1.18.x 的写法）。
- **没有测试会直接崩**：MDK 的注释就写了 "the server will crash when no gametests are provided"。
- 首次构建要下 Gradle、ForgeGradle、MC 和 Forge 的依赖（几百 MB，走代理）。
  代理不能靠环境变量，Gradle 只认 `systemProp.*`（已经写在 `gradle.properties` 里）。

## 测试结构模板放哪（踩出来的）

`GameTestServer` **不从 classpath 读** `.snbt`：`StructureUtils.getStructureTemplate` 先问
`StructureManager` 要 `data/<ns>/structures/<name>.nbt`，取不到就
`Paths.get(testStructuresDir, <name>.snbt)`，而 `testStructuresDir` 默认就是
**`gameteststructures`（相对工作目录）**。所以结构文件的真相放在仓库的
`gameteststructures/`，由 `build.gradle` 里的 `stageGameTestStructures` 拷进 `run/`——
可复现，不用手动摆放。

`empty3x3x3.snbt` 的键名是从字节码里读出来的（`size` / `palette` / `blocks` / `entities` /
`DataVersion`），`DataVersion: 2975` 来自客户端 jar 的 `version.json`（1.18.2）。

## 版本对齐

| | 值 | 为什么 |
|---|---|---|
| MC / Forge | 1.18.2 / 40.2.0 | 和 `../mc-art.settings.json` 里的参考目录同一版本 |
| Java | 17 | 1.18+ 的要求；本机 `java 17.0.20.1` |
| GameTest | Forge ≥ 39.0.88 才有 | 40.2.0 满足，MDK 自带 `gameTestServer` 运行配置 |
