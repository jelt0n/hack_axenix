import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.Range;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.NodeList;
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
            JsonObject edit = request.has("edit") && !request.get("edit").isJsonNull()
                ? request.getAsJsonObject("edit") : null;
            System.out.println(JSON.toJson(parse(request.get("source").getAsString(), edit)));
        } catch (EditRejected error) {
            System.out.println(JSON.toJson(Map.of("ok", false, "errors", List.of(
                Map.of("message", error.getMessage(), "line", 1, "column", 1)))));
        } catch (StackOverflowError | OutOfMemoryError error) {
            System.out.println("{\"ok\":false,\"errors\":[{\"message\":\"Программа слишком сложна для разбора\",\"line\":1,\"column\":1}]}");
        } catch (Exception error) {
            System.err.println(error.getClass().getSimpleName() + ": " + error.getMessage());
            System.exit(1);
        }
    }

    private static final class EditRejected extends RuntimeException {
        EditRejected(String message) { super(message); }
    }

    private static Map<String, Object> parse(String source, JsonObject edit) {
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
        Graph selectedGraph = null;
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
            Graph graph = new Graph(id, node);
            graphs.put(id, graph.build(body));
            if (edit != null && id.equals(edit.get("methodId").getAsString())) selectedGraph = graph;
        }
        if (edit != null) {
            if (selectedGraph == null) throw new EditRejected("Метод не найден. Обновите граф.");
            selectedGraph.edit(edit, parser);
            return parse(LexicalPreservingPrinter.print(unit), null);
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
        final Map<String, Node> origins = new LinkedHashMap<>();
        final Map<String, Sequence> sequences = new LinkedHashMap<>();
        final Map<Statement, Sequence> owners = new IdentityHashMap<>();
        String exit;

        Graph(String methodId, Node declaration) {
            this.methodId = methodId;
            this.declaration = declaration;
        }

        Map<String, Object> build(Optional<BlockStmt> body) {
            if (body.isPresent()) {
                exit = add("exit", "Конец метода", declaration);
                String first = block(body.get(), exit, "method", "Тело метода");
                String entry = add("entry", "Вход в метод", declaration);
                connect(entry, first, "");
            }
            return Map.of("methodId", methodId, "nodes", nodes, "edges", edges,
                "notices", notices, "containers", sequences.values().stream().map(s -> s.publicData()).toList());
        }

        String block(BlockStmt body, String next, String kind, String label) {
            register(new Sequence(body, null, false, kind, label));
            return sequence(body.getStatements(), next);
        }

        void register(Sequence container) {
            container.id = methodId + "-sequence-" + sequences.size();
            sequences.put(container.id, container);
            for (Statement statement : container.statements()) owners.put(statement, container);
        }

        String branch(IfStmt branch, boolean otherwise, String next) {
            Statement body = otherwise ? branch.getElseStmt().orElse(null) : branch.getThenStmt();
            String kind = otherwise ? "else" : "then";
            String label = "Ветка «" + (otherwise ? "Нет" : "Да") + "», строка "
                + branch.getBegin().orElseThrow().line;
            if (body instanceof BlockStmt block) return block(block, next, kind, label);
            register(new Sequence(null, branch, otherwise, kind, label));
            return body == null ? next : statement(body, next);
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
                return block(statement.asBlockStmt(), next, "block", "Блок, строка "
                    + statement.getBegin().orElseThrow().line);
            }
            if (statement.isIfStmt()) {
                IfStmt branch = statement.asIfStmt();
                String id = add("condition", branch.getCondition().toString(), branch.getCondition());
                connect(id, branch(branch, false, next), "Да");
                connect(id, branch(branch, true, next), "Нет");
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
            origins.put(id, origin);
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("id", id); node.put("kind", kind); node.put("code", code);
            node.put("range", location(origin));
            node.put("editable", kind.equals("operation") || kind.equals("return") || kind.equals("condition"));
            Sequence container = origin instanceof Statement statement ? owners.get(statement) : null;
            if (container != null) {
                node.put("containerId", container.id);
                node.put("index", container.indexOf(origin));
            }
            nodes.add(node);
            return id;
        }

        Statement operation(JsonObject request, JavaParser parser) {
            if (!request.has("code") || request.get("code").getAsString().isBlank()) {
                throw new EditRejected("Введите Java-код блока.");
            }
            var parsed = parser.parseStatement(request.get("code").getAsString());
            if (!parsed.isSuccessful() || parsed.getResult().isEmpty()) {
                throw new EditRejected("Введите одну корректную операцию Java с точкой с запятой.");
            }
            Statement value = parsed.getResult().orElseThrow();
            if (!(value.isExpressionStmt() || value.isReturnStmt() || value.isThrowStmt()
                    || value.isEmptyStmt() || value.isAssertStmt())) {
                throw new EditRejected("Здесь поддерживается одна операция; структуры управления редактируются отдельно.");
            }
            return value;
        }

        void edit(JsonObject request, JavaParser parser) {
            String action = request.get("action").getAsString();
            if (action.equals("delete") || action.equals("move")) {
                Node target = request.has("nodeId") ? origins.get(request.get("nodeId").getAsString()) : null;
                Sequence container = target instanceof Statement statement ? owners.get(statement) : null;
                if (container == null || !(target instanceof Statement statement)
                        || !(statement.isExpressionStmt() || statement.isReturnStmt() || statement.isThrowStmt()
                            || statement.isEmptyStmt() || statement.isAssertStmt())) {
                    throw new EditRejected("Удалить или переместить можно только отдельную операцию актуального графа.");
                }
                List<Statement> statements = new ArrayList<>(container.statements());
                int previous = container.indexOf(target);
                if (action.equals("move")) {
                    if (!request.has("containerId") || !container.id.equals(request.get("containerId").getAsString())) {
                        throw new EditRejected("Перемещение между областями видимости пока не поддерживается. Выберите ту же последовательность.");
                    }
                    if (!request.has("index")) throw new EditRejected("Укажите позицию перемещения.");
                    int index = request.get("index").getAsInt();
                    if (index < 0 || index > statements.size()) throw new EditRejected("Позиция перемещения отсутствует в последовательности.");
                    if (index > previous) index--;
                    if (index == previous) return;
                    Statement moved = statements.remove(previous);
                    statements.add(index, moved);
                } else statements.remove(previous);
                container.write(statements, parser);
                return;
            }
            if (request.get("action").getAsString().equals("insert")) {
                Sequence container = request.has("containerId")
                    ? sequences.get(request.get("containerId").getAsString()) : null;
                if (container == null) throw new EditRejected("Выберите последовательность или ветку актуального графа.");
                List<Statement> statements = new ArrayList<>(container.statements());
                int index = request.has("index") ? request.get("index").getAsInt() : statements.size();
                if (index < 0 || index > statements.size()) throw new EditRejected("Позиция вставки отсутствует в последовательности.");
                statements.add(index, operation(request, parser));
                container.write(statements, parser);
                return;
            }
            if (!request.get("action").getAsString().equals("replace")) {
                throw new EditRejected("Это структурное действие пока не поддерживается.");
            }
            Node target = request.has("nodeId") ? origins.get(request.get("nodeId").getAsString()) : null;
            var metadata = nodes.stream().filter(n -> n.get("id").equals(
                request.has("nodeId") ? request.get("nodeId").getAsString() : "")).findFirst();
            if (target == null || metadata.isEmpty() || !Boolean.TRUE.equals(metadata.get().get("editable"))) {
                throw new EditRejected("Выберите операцию или условие актуального графа.");
            }
            if (!request.has("code") || request.get("code").getAsString().isBlank()) {
                throw new EditRejected("Введите Java-код блока.");
            }
            String code = request.get("code").getAsString();
            if (metadata.get().get("kind").equals("condition")) {
                var parsed = parser.parseExpression(code);
                if (!parsed.isSuccessful() || parsed.getResult().isEmpty()) {
                    throw new EditRejected("Введите одно корректное Java-выражение условия.");
                }
                target.replace(parsed.getResult().orElseThrow());
            } else {
                Statement replacement = operation(request, parser);
                Sequence container = target instanceof Statement statement ? owners.get(statement) : null;
                if (container != null) {
                    List<Statement> statements = new ArrayList<>(container.statements());
                    statements.set(container.indexOf(target), replacement);
                    Sequence.validate(statements);
                }
                target.replace(replacement);
            }
        }

        static final class Sequence {
            String id;
            final BlockStmt block;
            final IfStmt branch;
            final boolean otherwise;
            final String kind;
            final String label;

            Sequence(BlockStmt block, IfStmt branch, boolean otherwise, String kind, String label) {
                this.block = block; this.branch = branch; this.otherwise = otherwise;
                this.kind = kind; this.label = label;
            }

            List<Statement> statements() {
                if (block != null) return block.getStatements();
                Statement statement = otherwise ? branch.getElseStmt().orElse(null) : branch.getThenStmt();
                return statement == null ? List.of() : List.of(statement);
            }

            int indexOf(Node node) {
                List<Statement> statements = statements();
                for (int i = 0; i < statements.size(); i++) if (statements.get(i) == node) return i;
                throw new EditRejected("Операция отсутствует в актуальной последовательности.");
            }

            static void validate(List<Statement> statements) {
                for (int i = 1; i < statements.size(); i++) {
                    if (statements.get(i).isExplicitConstructorInvocationStmt()) {
                        throw new EditRejected("Вызов this(...) или super(...) должен оставаться первым в конструкторе.");
                    }
                }
                for (int i = 0; i + 1 < statements.size(); i++) {
                    if (statements.get(i).isReturnStmt() || statements.get(i).isThrowStmt()) {
                        throw new EditRejected("После return или throw нельзя размещать операции в той же последовательности.");
                    }
                }
            }

            void write(List<Statement> statements, JavaParser parser) {
                validate(statements);
                if (block != null) block.setStatements(new NodeList<>(statements));
                else if (otherwise && branch.getElseStmt().isEmpty()) {
                    // JavaParser 3.27.1 cannot lexically add an else to an unbraced if.
                    // Replace only that if; braces also prevent dangling-else reassociation.
                    IfStmt replacement = parser.parseStatement(branch.toString()).getResult()
                        .orElseThrow(() -> new EditRejected("Не удалось дополнить ветку if/else.")).asIfStmt();
                    if (!replacement.getThenStmt().isBlockStmt()) {
                        replacement.setThenStmt(new BlockStmt(new NodeList<>(replacement.getThenStmt().clone())));
                    }
                    NodeList<Statement> body = new NodeList<>();
                    for (Statement statement : statements) body.add(statement.clone());
                    replacement.setElseStmt(new BlockStmt(body));
                    branch.replace(replacement);
                }
                else {
                    BlockStmt replacement = new BlockStmt(new NodeList<>(statements));
                    if (otherwise) branch.setElseStmt(replacement); else branch.setThenStmt(replacement);
                }
            }

            Map<String, Object> publicData() {
                return Map.of("id", id, "kind", kind, "label", label, "size", statements().size());
            }
        }

        void connect(String from, String to, String label) {
            edges.add(Map.of("id", "edge-" + edges.size(), "source", from,
                "target", to, "label", label));
        }
    }
}
