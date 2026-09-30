# The judge: GameTestServer

`GameTestServer` is Mojang's own special dedicated server: it runs every registered
game test and then **exits, with the exit code equal to the number of failed
required tests**. No window, no keyboard, no screenshots — a number the game itself
produced. That is why it, and not a bot, is the primary way to check a mod.

- Introduced in **1.17**; Forge support needs **1.18.1+ / Forge 39.0.88+**;
  Fabric API ships `fabric-gametest` with its own entrypoint.
- Tests are Java methods that assert on a real world: block interactions, entity
  behaviour, item functionality, capabilities.
- Tests need a **template structure** (see below). An empty 3×3×3 is enough for
  "set a block and check it is there".

## The loop

```bash
# in the mod project
python tools/mcmod_gametest.py                 # verdict + parsed log + result JSON
python tools/mcmod_gametest.py --fault         # inject a false assertion: it MUST fail
./gradlew runGameTestServer --no-daemon --console=plain   # what the tool runs
#   (Windows: gradlew.bat -- the tool picks it by platform)
echo $?                                         # = failed required tests
```

Measured (1.18.2 / Forge 40.2.0, this workspace):

```
clean    →  [minecraft/GameTestServer]: All 2 required tests passed :)          exit 0
--fault  →  [minecraft/LogTestReporter]: <测试名> failed! <断言里的那句话> at 1,-59,1 (relative: 1,1,1)
#   （这行的形状来自一次真实运行；测试名与消息换成了占位符——那是作者自己的示例项目）
            [minecraft/GameTestServer]: 1 required tests failed :(             exit 1
```

First build ≈ 26 min (Gradle distribution + MC/Forge artifacts + a few hundred MB of
vanilla assets, through the proxy). **Every run after that ≈ 1 min.** Warm caches turn the
loop into something you can afford to run per change.

**Those assets are Gradle's own, and the panel's 参考目录 is not them.** `downloadAssets`
fills ForgeGradle's asset store under `GRADLE_USER_HOME` (put it inside the project — e.g.
`-g .gradle-home` — so it survives a clean and can be deleted as one directory). The panel's
reference root (see `panel.md`) is read by the **art engine** to show you vanilla/mod
textures and models for style matching; nothing in the build reads it, and pointing it at a
`.minecraft` does **not** stop this download. Both point at the same game installation, for
two different consumers — that is the whole relationship.

## Before the first build: does this JVM lie about writability?

**Symptom.** `runGameTestServer` dies in the access-transformer step with

```
java.nio.file.ReadOnlyFileSystemException
    at jdk.nio.zipfs.ZipFileSystem.checkWritable(ZipFileSystem.java:370)
    at net.minecraftforge.accesstransformer.TransformerProcessor.lambda$processJar$3
Could not find net.minecraftforge:forge:…_mapped_official_…       ← the AT output never appeared
```

and the artefact it left behind is a **22-byte empty zip** (`PK\x05\x06` + 18 zero bytes).
Exit code is `2` (stage = `setup`), not the number of failed tests — the judge script says so
and it is right to.

**Cause.** `jdk.zipfs` decides whether a jar is writable with `Files.isWritable()`. A JVM
started from Mojang's bundled runtime (`%APPDATA%\\.minecraft\\runtime\\java-runtime-gamma*`)
runs at **Low mandatory integrity** (`Mandatory Label\\Low`, `S-1-16-4096`), and in that
context `Files.isWritable()` returns **false even for a file the JVM just wrote itself** —
writes succeed, the access check does not. Every jar therefore looks read-only, so the AT
step can never write. A sandbox that grants writes through a capability SID without the full
`FILE_GENERIC_WRITE` mask produces the same lie; that is why "cmd can write `%TEMP%`, java
cannot" looks like a sandbox problem and is not.

**Fix.** Use a normal JDK 17/21 (Temurin / Microsoft / Oracle / JBR). Do **not** use
Minecraft's bundled `runtime` java to build. `scripts/check_jdk.py` resolves one and proves it
by running `scripts/JvmWriteSelfTest.java` — write a file, ask `isWritable`, write a zip entry
through zipfs — and reports every candidate it rejected and why:

```bash
python3 scripts/check_jdk.py                       # find one; exit 3 = none usable
python3 scripts/check_jdk.py --java-home 'C:\Program Files\\Eclipse Adoptium\\jdk-17…'
```

A copy of the same JDK placed in an ordinary directory inherits **Medium** and works, which is
one cheap repair when the only 17 on the machine is the game's.

**Do not try to repair this with ACLs.** Granting more rights on the workspace does not move
the process off Low integrity, and raising the directory to Medium makes a Low process unable
to write *downward* at all — measured, it gets worse. Change the JVM, or change the execution
environment.

**Ask the JVM you are about to build with, not the version string.** "It is javac 17" is not
the question; "can this JVM write a jar" is.

## What the project must contain

**A GameTest class** (or several). For 1.18.x the working shape is:

```java
import net.minecraft.gametest.framework.GameTest;          // vanilla annotation
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraftforge.event.RegisterGameTestsEvent;    // Forge: registration
import net.minecraftforge.gametest.PrefixGameTestTemplate; // Forge: template naming

@Mod.EventBusSubscriber(modid = MODID, bus = Mod.EventBusSubscriber.Bus.MOD)
public final class MyGameTests {
    @SubscribeEvent
    public static void onRegisterGameTests(RegisterGameTestsEvent event) {
        event.register(MyGameTests.class);          // whole class at once
    }

    @PrefixGameTestTemplate(false)
    @GameTest(templateNamespace = MODID, template = "empty3x3x3")
    public static void blockPlaces(GameTestHelper helper) {
        BlockPos pos = new BlockPos(1, 1, 1);
        helper.setBlock(pos, MyBlocks.THING.get());
        helper.assertBlockState(pos, s -> s.is(MyBlocks.THING.get()), () -> "not my block");
        helper.succeed();
    }
}
```

`@GameTestHolder(MODID)` on the class is the shorter (annotation-scanning) alternative
to `RegisterGameTestsEvent`.

### `GameTestHelper` — the real API (1.18.2, from `javap`)

| exists | does not exist |
|---|---|
| `setBlock(BlockPos, Block)`, `setBlock(BlockPos, BlockState)` | **`assertTrue(boolean, String)`** |
| `assertBlockState(pos, Predicate<BlockState>, Supplier<String>)` | `assertEquals(…)` |
| `assertBlock(pos, Predicate<Block>, String)` | |
| `assertBlockPresent/NotPresent(Block, pos)` | |
| `fail(String)`, `fail(String, BlockPos)`, `failIf(Runnable)`, `failIfEver(Runnable)` | |
| `succeed()`, `succeedIf(Runnable)`, `succeedWhen(Runnable)`, `succeedOnTickWhen(int, Runnable)` | |
| `runAtTickTime(long, Runnable)`, `runAfterDelay(…)` | |

A test that never calls `succeed()` **fails by timeout** (100 ticks by default).

## The template structure (the trap that costs the first run)

`StructureUtils.getStructureTemplate`:
1. asks the `StructureManager` for `data/<ns>/structures/<name>.nbt` (a pack resource), then
2. falls back to the **filesystem**: `Paths.get(testStructuresDir, <path> + ".snbt")`,
   and `testStructuresDir` defaults to **`gameteststructures`, relative to the working
   directory**.

So for a dev run the file must exist at `<working dir>/gameteststructures/<name>.snbt`.
Keep the authoring copy in the repository and **stage it with Gradle** — a run that
depends on someone having dropped a file into `run/` is not reproducible:

```groovy
tasks.register('stageGameTestStructures', Copy) {
    from 'gameteststructures'
    into 'run/gameteststructures'
}
// NOT tasks.named(...): ForgeGradle creates the run tasks AFTER the
// `minecraft { runs { … } }` block, so `named` fails at configuration time.
tasks.matching { it.name == 'runGameTestServer' }.configureEach {
    dependsOn 'stageGameTestStructures'
}
```

`empty3x3x3.snbt` — the keys were read out of the bytecode
(`size` / `palette` / `blocks` / `entities` / `DataVersion`), the DataVersion out of
the client jar's `version.json`:

```snbt
{
    DataVersion: 2975,
    size: [3, 3, 3],
    palette: [],
    blocks: [],
    entities: []
}
```

## The Gradle bits that are not optional

```groovy
gameTestServer {
    workingDirectory project.file('run')
    forceExit false            // ← without this the verdict is erased (default true)
    jvmArgs '-Xmx2G'           // size to the machine
    property 'forge.enabledGameTestNamespaces', '<modid>'
    mods { <modid> { source sourceSets.main } }
}
```

- **`forceExit false`**: `runGameTestServer` normally forces the process exit and the
  task always reports success. The whole verdict is the exit code, so this must be off.
  Forge's own CI example does it for the same reason.
- **Proxy**: Gradle **ignores `http_proxy` from the environment**; put
  `systemProp.http(s).proxyHost/Port` in `gradle.properties` (and `GRADLE_OPTS` for the
  wrapper's own distribution download), or nothing downloads at all.
- `org.gradle.daemon=false` + `--no-daemon` is fine (and kinder on a small machine).

## Reading the verdict honestly

Exit code = failed required tests **only on a run that reached the tests**. A compile
failure also exits non-zero. So the tool:

- requires **evidence in the log** (`Running test batch …` or the closing line) before
  it calls the stage `ran`;
- **cross-checks** the exit code against the log's own count (`exitCodeMatchesLog`) —
  that is the only place a masked exit code can be caught;
- parses the real format (successes are only *counted*; failures are *named*:
  `<name> failed! <message> at x,y,z`).

Never report "N failed" when the stage was `compile`. The number means something only
in its context.

## What the judge cannot do

- **Look.** It asserts behaviour; whether the thing looks right, feels right, or
  reads well in a tooltip is a human stage (`workflow.md` stage 6).
- **Run with the pack.** A dev run is bare (vanilla + Forge + our mod). "Does it
  survive next to 40 other mods" needs a real instance — that is a separate,
  deliberate step.
