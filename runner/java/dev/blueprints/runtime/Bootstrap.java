package dev.blueprints.runtime;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.io.DataInputStream;
import java.io.ByteArrayInputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.IdentityHashMap;
import java.util.HexFormat;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Trusted launcher: ordinary stderr and the VM's uncaught exception are separate observations. */
public final class Bootstrap {
    private static final Path REPORT = Path.of("/work/outcome.json");

    public static void main(String[] args) throws Exception {
        DataInputStream incoming = new DataInputStream(System.in);
        byte[] key = incoming.readNBytes(32);
        int length = incoming.readInt();
        if (key.length != 32 || length < 0 || length > 32768) throw new IllegalArgumentException("Invalid input envelope");
        byte[] scenario = incoming.readNBytes(length);
        if (scenario.length != length) throw new IllegalArgumentException("Incomplete input envelope");
        System.setIn(new ByteArrayInputStream(scenario));
        writeReport("{\"stage\":\"launcher\"}", key);
        Method entry;
        try {
            Class<?> target = Class.forName(args[0], false, Bootstrap.class.getClassLoader());
            entry = target.getMethod("main", String[].class);
            if (!Modifier.isStatic(entry.getModifiers()) || entry.getReturnType() != void.class) {
                throw new NoSuchMethodException("Expected public static void main(String[] args)");
            }
            entry.setAccessible(true);
        } catch (ReflectiveOperationException | LinkageError error) {
            writeReport("{\"stage\":\"entrypoint_error\",\"message\":"
                + quote(error.toString()) + "}", key);
            System.exit(1);
            return;
        }
        Outcome outcome = new Outcome(key);
        Runtime.getRuntime().addShutdownHook(new Thread(outcome::finish, "blueprints-outcome"));
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> outcome.capture(thread, error));
        writeReport("{\"stage\":\"entered\"}", key);
        try {
            entry.invoke(null, (Object) new String[0]);
        } catch (Throwable error) {
            Throwable cause = error instanceof InvocationTargetException invocation
                ? invocation.getCause() : error;
            outcome.capture(Thread.currentThread(), cause);
            System.exit(1);
        }
    }

    private static final class Outcome {
        private final byte[] key;
        private final byte[] resourceFallback;
        private final byte[] reportFallback;
        private final List<String> exceptions = new ArrayList<>();
        private final List<String> stacks = new ArrayList<>();
        // Keep room to report a retained-heap OOM; incomplete reports never count as success.
        private byte[] reserve = new byte[4 * 1024 * 1024];
        private boolean resource;
        private boolean reportingFailed;
        private boolean finalizing;

        Outcome(byte[] key) throws Exception {
            this.key = key;
            resourceFallback = signedReport("{\"stage\":\"finished\",\"resourceLimit\":true}", key);
            reportFallback = signedReport("{\"stage\":\"report_error\"}", key);
        }

        synchronized void capture(Thread thread, Throwable error) {
            reserve = null;
            boolean previousFailure = reportingFailed;
            reportingFailed = true;
            try {
                resource |= isResource(error, 0);
                StringWriter buffer = new StringWriter();
                buffer.append("Exception in thread \"").append(thread.getName()).append("\" ");
                error.printStackTrace(new PrintWriter(buffer));
                String stack = buffer.toString();
                exceptions.add(describe(error, new IdentityHashMap<>(), 0));
                stacks.add(quote(stack));
                reportingFailed = previousFailure;
            } catch (Throwable reportingError) {
                resource |= reportingError instanceof OutOfMemoryError
                    || reportingError instanceof StackOverflowError;
            } finally {
                if (finalizing) finish();
            }
        }

        synchronized void finish() {
            reserve = null;
            finalizing = true;
            try {
                if (reportingFailed) {
                    Files.write(REPORT, resource ? resourceFallback : reportFallback);
                    return;
                }
                String exception = exceptions.isEmpty() ? "null" : exceptions.size() == 1
                    ? exceptions.get(0) : "{\"type\":\"MultipleUncaughtExceptions\",\"message\":null,"
                        + "\"cause\":null,\"suppressed\":[" + String.join(",", exceptions) + "]}";
                writeReport("{\"stage\":\"finished\",\"resourceLimit\":" + resource
                    + ",\"exception\":" + exception + ",\"stackTraces\":["
                    + String.join(",", stacks) + "]}", key);
            } catch (Throwable reportingError) {
                try {
                    resource |= isResource(reportingError, 0);
                    Files.write(REPORT, resource ? resourceFallback : reportFallback);
                } catch (Throwable ignored) { /* Missing final report is inconclusive. */ }
            }
        }
    }

    private static boolean isResource(Throwable error, int depth) {
        return error != null && (error instanceof OutOfMemoryError || error instanceof StackOverflowError
            || depth < 12 && isResource(error.getCause(), depth + 1));
    }

    private static void writeReport(String payload, byte[] key) throws Exception {
        Files.write(REPORT, signedReport(payload, key));
    }

    private static byte[] signedReport(String payload, byte[] key) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        String signature = HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        return ("{\"payload\":" + quote(payload) + ",\"signature\":"
            + quote(signature) + "}").getBytes(StandardCharsets.UTF_8);
    }

    private static String describe(Throwable error, IdentityHashMap<Throwable, Boolean> seen, int depth) {
        if (error == null) return "null";
        if (depth > 12 || seen.put(error, true) != null) return "{\"truncated\":true}";
        StringBuilder suppressed = new StringBuilder("[");
        Throwable[] children = error.getSuppressed();
        for (int i = 0; i < children.length; i++) {
            if (i > 0) suppressed.append(',');
            if (i >= 12) { suppressed.append("{\"truncated\":true}"); break; }
            suppressed.append(describe(children[i], seen, depth + 1));
        }
        suppressed.append(']');
        return "{\"type\":" + quote(error.getClass().getName()) + ",\"message\":"
            + (error.getMessage() == null ? "null" : quote(error.getMessage()))
            + ",\"cause\":" + describe(error.getCause(), seen, depth + 1)
            + ",\"suppressed\":" + suppressed + "}";
    }

    private static String quote(String value) {
        StringBuilder output = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (c < 32) output.append(String.format("\\u%04x", (int) c));
                    else output.append(c);
                }
            }
        }
        return output.append('"').toString();
    }
}
