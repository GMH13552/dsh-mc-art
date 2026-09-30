import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

/**
 * ASCII only, single-file launch:  java JvmWriteSelfTest.java <dir>
 *
 * WHY THIS EXISTS.  "Can this JVM write a jar?" is not a question you can answer by
 * looking at the JDK's version string, and ForgeGradle dies on exactly that question.
 *
 * Two real mechanisms make a JVM unable to write where it visibly should:
 *
 *   * a **Low mandatory integrity label** on the JDK's own files (Mojang's bundled
 *     `java-runtime-gamma-snapshot` carries one).  A process started from it inherits
 *     Low, and then `Files.isWritable()` returns FALSE even for a file the JVM just
 *     wrote itself.  `jdk.zipfs` uses precisely that call to decide whether a jar is
 *     writable, so every jar looks read-only to it:
 *     `java.nio.file.ReadOnlyFileSystemException at jdk.nio.zipfs.ZipFileSystem.checkWritable`
 *     -- which is where ForgeGradle's access transformer step dies, leaving a 22-byte
 *     empty jar (`PK\x05\x06` + 18 zero bytes) behind;
 *   * a sandbox that grants writes through a capability SID without granting the full
 *     `FILE_GENERIC_WRITE` access mask (the same lie, different source).
 *
 * So the check is behavioural: **write a file, ask whether it is writable, then write a
 * zip entry through zipfs** -- all three against the directory the build will really use.
 *
 * Exit codes: 0 = this JVM can write files and jars; 3 = it cannot (the caller prints why).
 */
public class JvmWriteSelfTest {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: java JvmWriteSelfTest.java <dir>");
            System.exit(2);
        }
        Path dir = Paths.get(args[0]);
        Files.createDirectories(dir);
        Path file = dir.resolve("write-selftest.txt");
        Files.write(file, "x".getBytes("UTF-8"));
        if (!Files.isWritable(file)) {
            System.err.println("SELFTEST FAIL: Files.isWritable=false for a file this JVM just wrote");
            System.err.println("  file=" + file);
            System.err.println("  java.version=" + System.getProperty("java.version"));
            System.err.println("  java.home=" + System.getProperty("java.home"));
            System.err.println("  -> a jar written by this JVM will look read-only to jdk.zipfs");
            System.exit(3);
        }
        Path zip = dir.resolve("write-selftest.zip");
        Files.deleteIfExists(zip);
        Map<String, Object> env = new HashMap<String, Object>();
        env.put("create", "true");
        try {
            FileSystem fs = FileSystems.newFileSystem(zip, env);
            try {
                Files.write(fs.getPath("/entry.txt"), "hi".getBytes("UTF-8"));
            } finally {
                fs.close();
            }
        } catch (Exception error) {
            System.err.println("SELFTEST FAIL: cannot write a zip through zipfs: " + error);
            System.err.println("  java.version=" + System.getProperty("java.version"));
            System.exit(3);
        }
        Files.deleteIfExists(zip);
        Files.deleteIfExists(file);
        System.out.println("SELFTEST OK: files and jars are writable");
        System.out.println("  java.version=" + System.getProperty("java.version"));
        System.out.println("  java.home=" + System.getProperty("java.home"));
    }
}
