import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.Range;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.stmt.*;
import com.github.javaparser.printer.lexicalpreservation.LexicalPreservingPrinter;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Reads source as data; never compiles or executes the submitted Java program. */
public final class BlueprintParser {
    private static final Gson JSON = new GsonBuilder().disableHtmlEscaping().create();

    public static void main(String[] args) {
        try {
            JsonObject request = JsonParser.parseString(
                new String(System.in.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
            String source = request.get("source").getAsString();
            Map<String, Object> parsed = parse(source);
            if (request.has("analyze") && request.get("analyze").getAsBoolean()
                    && Boolean.TRUE.equals(parsed.get("ok"))) {
                parsed = new LinkedHashMap<>(parsed);
                parsed.put("analysis", BlueprintAnalyzer.analyze(source, parsed));
            }
            System.out.println(JSON.toJson(parsed));
        } catch (StackOverflowError | OutOfMemoryError error) {
            System.out.println("{\"ok\":false,\"errors\":[{\"message\":\"Программа слишком сложна для разбора\",\"line\":1,\"column\":1}]}");
        } catch (Exception error) {
            System.err.println(error.getClass().getSimpleName() + ": " + error.getMessage());
            System.exit(1);
        }
    }

    private static Map<String, Object> parse(String source) {
        JavaParser parser = new JavaParser(new ParserConfiguration().setTabSize(1)
            .setLanguageLevel(ParserConfiguration.LanguageLevel.BLEEDING_EDGE));
        ParseResult<CompilationUnit> result = parser.parse(source);
        if (!result.isSuccessful() || result.getResult().isEmpty()) {
            List<Object> errors = new ArrayList<>();
            result.getProblems().stream().limit(12).forEach(problem -> {
                var position = problem.getLocation().flatMap(tokens -> tokens.toRange());
                errors.add(Map.of("message", problem.getMessage(),
                    "line", position.map(r -> r.begin.line).orElse(1),
                    "column", position.map(r -> r.begin.column).orElse(1)));
            });
            return Map.of("ok", false, "errors", errors);
        }
        CompilationUnit unit = result.getResult().orElseThrow();
        LexicalPreservingPrinter.setup(unit);
        List<Object> methods = new ArrayList<>();
        Map<String, Object> graphs = new LinkedHashMap<>();
        for (Node node : unit.findAll(Node.class)) {
            if (!(node instanceof MethodDeclaration) && !(node instanceof ConstructorDeclaration)) {
                continue;
            }
            CallableDeclaration<?> callable = (CallableDeclaration<?>) node;
            Range range = node.getRange().orElseThrow();
            String id = "method-" + range.begin.line + "-" + range.begin.column;
            List<String> owners = new ArrayList<>();
            for (Node parent = node.getParentNode().orElse(null); parent != null;
                    parent = parent.getParentNode().orElse(null)) {
                if (parent instanceof TypeDeclaration<?> type) owners.add(type.getNameAsString());
            }
            Collections.reverse(owners);
            Optional<BlockStmt> body = node instanceof MethodDeclaration method
                ? method.getBody() : Optional.of(((ConstructorDeclaration) node).getBody());
            Map<String, Object> method = new LinkedHashMap<>();
            method.put("id", id);
            method.put("name", callable.getNameAsString());
            method.put("signature", callable.getSignature().asString());
            method.put("owner", String.join(".", owners));
            method.put("kind", node instanceof ConstructorDeclaration ? "constructor" : "method");
            method.put("range", location(node));
            method.put("hasBody", body.isPresent());
            methods.add(method);
            graphs.put(id, new Graph(id, node).build(body));
        }
        return Map.of("ok", true, "methods", methods, "graphs", graphs,
            "generatedSource", LexicalPreservingPrinter.print(unit),
            "packageName", unit.getPackageDeclaration().map(p -> p.getNameAsString()).orElse(""));
    }

    private static Map<String, Integer> location(Node node) {
        Range r = node.getRange().orElseThrow();
        return Map.of("startLine", r.begin.line, "startColumn", r.begin.column,
            "endLine", r.end.line, "endColumn", r.end.column);
    }

    private static final class Graph {
        final String methodId;
        final Node declaration;
        final List<Map<String, Object>> nodes = new ArrayList<>();
        final List<Map<String, Object>> edges = new ArrayList<>();
        final List<String> notices = new ArrayList<>();
        String exit;

        Graph(String methodId, Node declaration) {
            this.methodId = methodId;
            this.declaration = declaration;
        }

        Map<String, Object> build(Optional<BlockStmt> body) {
            if (body.isPresent()) {
                exit = add("exit", "Конец метода", declaration);
                String first = sequence(body.get().getStatements(), exit);
                String entry = add("entry", "Вход в метод", declaration);
                connect(entry, first, "");
            }
            return Map.of("methodId", methodId, "nodes", nodes, "edges", edges,
                "notices", notices);
        }

        String sequence(List<Statement> statements, String next) {
            String first = next;
            for (int i = statements.size() - 1; i >= 0; i--) {
                first = statement(statements.get(i), first);
            }
            return first;
        }

        String statement(Statement statement, String next) {
            if (statement.isBlockStmt()) {
                return sequence(statement.asBlockStmt().getStatements(), next);
            }
            if (statement.isIfStmt()) {
                IfStmt branch = statement.asIfStmt();
                String id = add("condition", branch.getCondition().toString(), branch.getCondition());
                connect(id, statement(branch.getThenStmt(), next), "Да");
                connect(id, branch.getElseStmt().map(s -> statement(s, next)).orElse(next), "Нет");
                return id;
            }
            boolean terminal = statement.isReturnStmt() || statement.isThrowStmt();
            boolean simple = terminal || statement.isExpressionStmt() || statement.isEmptyStmt()
                || statement.isAssertStmt();
            String kind = terminal ? "return" : simple ? "operation" : "opaque";
            String code = statement.getTokenRange().map(Object::toString).orElse(statement.toString());
            String id = add(kind, code, statement);
            if (!simple) {
                notices.add("Конструкция в строке " + statement.getBegin().orElseThrow().line
                    + " показана целиком: внутренний поток управления пока не раскрыт.");
            }
            connect(id, terminal ? exit : next, "");
            return id;
        }

        String add(String kind, String code, Node origin) {
            String id = methodId + "-" + nodes.size();
            nodes.add(Map.of("id", id, "kind", kind, "code", code, "range", location(origin)));
            return id;
        }

        void connect(String from, String to, String label) {
            edges.add(Map.of("id", "edge-" + edges.size(), "source", from,
                "target", to, "label", label));
        }
    }
}
