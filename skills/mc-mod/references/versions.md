# Versions: what is locked, what changes, and how to find out

A mod project is **one version**. That is not a limitation to work around, it is how
the ecosystem works: mappings, the Java API surface, the loader and the pack formats
all move together. What should be *shared* across versions is the design, the art,
the ids, the names, and the generation logic — not one jar serving several games.

## The matrix

Read this as **categories of change**, not as a table to memorise. The row for the
target you actually have is settled by that version's own files (next section).

| target | Java | in-game judge (GameTest) | notes |
|---|---|---|---|
| ≤ 1.12.2 | 8 | ❌ **does not exist** | different API generation entirely (`GameRegistry`, no data packs). Verification = compiles + server starts + log is clean |
| 1.16.5 | 8/11 | ❌ | |
| 1.17 – 1.18.1 | 16/17 | ✅ exists; on Forge needs **39.0.88+** | |
| 1.18.2 (measured once) | **17** | ✅ | Forge 40.2.0; `DataVersion` 2975; `pack_format` 9 / `forge:resource_pack_format` 8 / `forge:data_pack_format` 9 |
| 1.19.x | 17 | ✅ | creative tabs became a registry (see below) |
| 1.20.1 | 17 | ✅ | |
| 1.20.5+ / 1.21.x | 21 | ✅ | the largest API break of the era; port by template, never by memory |

**Say the ❌ out loud.** A pipeline that promises "verified mods" on 1.12.2 is
promising something the game cannot provide: there is no in-game assertion framework
before 1.17. On those versions the strongest honest claim is "it builds and the
server starts with a clean log".

## What changes between versions (the categories, not a memorized table)

1. **Mappings and the compiler**: `mappings channel: 'official', version: '<mc>'`;
   the Java language level (`java.toolchain.languageVersion`).
2. **The loader dependency**: `minecraft 'net.minecraftforge:forge:<mc>-<loader>'`,
   and the build plugin (ForgeGradle, Loom, or whatever the loader ships) major version.
3. **Data/resource pack formats**: `pack.mcmeta` — `pack_format`,
   `forge:resource_pack_format`, `forge:data_pack_format`. The *art* side reads these
   too: a pack built for one version's format is not the same file set as another's.
4. **The Java API surface** — this is the one that actually costs time:
   - item properties / creative tabs (tabs became a registry; `.tab(…)` disappeared),
   - block properties (`Material` was removed in favour of explicit properties),
   - registry and event names, data components (replacing NBT on item stacks),
   - design changes that are *conceptual*, e.g. what a "block item" is.
5. **The verification toolchain**: which test framework, which gradle task, which
   annotations. The vanilla GameTest framework needs 1.17+; on Forge it needs
   1.18.1+/39.0.88+; other loaders ship their own entrypoint and their own task name.

## How to find out — instead of guessing

Every one of these takes under a minute and beats a remembered version number. They are
written to run on any OS; where the shell differs, both forms are given.

```bash
# 1. The game's own version metadata (the DataVersion and the pack format).
#    <gradle home> is the build tool's cache directory (GRADLE_USER_HOME if it was moved).
JAR=<gradle home>/caches/forge_gradle/minecraft_repo/versions/<mc>/client.jar
python -c "import json,sys,zipfile;print(json.loads(zipfile.ZipFile(sys.argv[1]).read('version.json')))" "$JAR"
# Windows: python -c "..." "C:/path/to/client.jar"   (no shell variable needed)

# 2. The exact API of THIS version, from the mapped jar the build already produced
MAP=<gradle home>/caches/forge_gradle/minecraft_user_repo/net/minecraftforge/forge/<v>_mapped_official_<mc>/forge-<v>_mapped_official_<mc>.jar
javap -classpath "$MAP" net.minecraft.gametest.framework.GameTestHelper
javap -classpath "$MAP" net.minecraft.world.item.BlockItem

# 3. The strings a class actually uses (authoritative for file paths and keys)
javap -v -p -classpath "$MAP" net.minecraft.gametest.framework.StructureUtils | grep "= String"
# Windows: ... | findstr "= String"

# 4. The compiler is a 13-second judge on a warm cache
./gradlew compileJava        # Windows: gradlew.bat compileJava
```

If you cannot run any of that yet, the next-best sources, in order: the pack metadata of
an existing pack for that version (`pack.mcmeta`), the loader's own published version
list, and only then a search engine. **Never** trust a blog post or memory for an exact
signature — the version in front of you is the truth, and `javap` prints it.

## The guard to build into any generator

- **Reference version == build target.** If the art settings point at 1.12.2 while the
  project compiles against 1.18.2, the art was read with the wrong rules and nothing
  will complain. Warn loudly.
- **Capabilities follow the version.** The pipeline should report, per target,
  whether it can generate assets (usually yes) and whether it can *verify behaviour*
  (1.17+ only).
- **Templates are per version.** `templates/<loader>/<mc>/…` for build files, pack
  metadata, registration code and the GameTest skeleton. "Supporting a new version"
  should be adding a directory and a row in the matrix — not editing scattered
  numbers across a repository.
