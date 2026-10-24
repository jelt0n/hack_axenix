import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.Range;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.NodeList;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.PatternExpr;
import com.github.javaparser.ast.expr.SwitchExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithBody;
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
            JsonObject edit = request.has("edit") && !request.get("edit").isJsonNull()
                ? request.getAsJsonObject("edit") : null;
            boolean analyze = request.has("analyze") && request.get("analyze").getAsBoolean();
            System.out.println(JSON.toJson(parse(source, edit, analyze)));
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

    private static Map<String, Object> parse(String source, JsonObject edit, boolean analyze) {
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
            String id = methodId(node);
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
            return parse(LexicalPreservingPrinter.print(unit), null, analyze);
        }
        Map<String, Object> parsed = new LinkedHashMap<>(Map.of("ok", true, "methods", methods, "graphs", graphs,
            "generatedSource", LexicalPreservingPrinter.print(unit),
            "packageName", unit.getPackageDeclaration().map(p -> p.getNameAsString()).orElse("")));
        if (analyze) parsed.put("analysis", BlueprintAnalyzer.analyze(unit, parsed));
        return parsed;
    }

    static String methodId(Node node) {
        var start = node.getBegin().orElseThrow();
        return "method-" + start.line + "-" + start.column;
    }

    static Map<String, Integer> location(Node node) {
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
        final Deque<Control> controls = new ArrayDeque<>();
        record Flow(String id, boolean backEdge, String completion) {
            Flow(String id, boolean backEdge) { this(id, backEdge, ""); }
        }
        record Control(Flow breakTo, Flow continueTo) {}
        String exit;
        Flow returnTo;
        Flow exceptionTo;

        Graph(String methodId, Node declaration) {
            this.methodId = methodId;
            this.declaration = declaration;
        }

        Map<String, Object> build(Optional<BlockStmt> body) {
            if (body.isPresent()) {
                exit = add("exit", "Конец метода", declaration);
                returnTo = new Flow(exit, false);
                exceptionTo = new Flow(exit, false);
                Flow first = block(body.get(), new Flow(exit, false), "method", "Тело метода");
                String entry = add("entry", "Вход в метод", declaration);
                connect(entry, first, "");
            }
            return Map.of("methodId", methodId, "nodes", nodes, "edges", edges,
                "notices", notices.stream().distinct().toList(), "containers", sequences.values().stream().map(s -> s.publicData()).toList());
        }

        Flow block(BlockStmt body, Flow next, String kind, String label) {
            register(new Sequence(body, false, kind, label));
            return sequence(body.getStatements(), next);
        }

        void register(Sequence container) {
            container.id = methodId + "-sequence-" + sequences.size();
            sequences.put(container.id, container);
            for (Statement statement : container.statements()) owners.put(statement, container);
        }

        Flow branch(IfStmt branch, boolean otherwise, Flow next) {
            Statement body = otherwise ? branch.getElseStmt().orElse(null) : branch.getThenStmt();
            String kind = otherwise ? "else" : "then";
            String label = "Ветка «" + (otherwise ? "Нет" : "Да") + "», строка "
                + branch.getBegin().orElseThrow().line;
            if (body instanceof BlockStmt block) return block(block, next, kind, label);
            register(new Sequence(branch, otherwise, kind, label));
            return body == null ? next : statement(body, next);
        }

        Flow sequence(List<Statement> statements, Flow next) {
            Flow first = next;
            for (int i = statements.size() - 1; i >= 0; i--) {
                first = statement(statements.get(i), first);
            }
            return first;
        }

        Flow loopBody(Statement loop, Flow next, String name) {
            Statement body = ((NodeWithBody<?>) loop).getBody();
            String label = "Тело " + name + ", строка " + loop.getBegin().orElseThrow().line;
            if (body instanceof BlockStmt block) return block(block, next, "loop", label);
            register(new Sequence(loop, false, "loop", label));
            return statement(body, next);
        }

        Flow controlExpressions(List<Expression> expressions, Flow next) {
            Flow first = next;
            for (int i = expressions.size() - 1; i >= 0; i--) {
                Expression expression = expressions.get(i);
                String id = add("control", expression.toString(), expression);
                connect(id, first, "");
                first = new Flow(id, false);
            }
            return first;
        }

        Flow statement(Statement statement, Flow next) {
            boolean terminal = statement.isReturnStmt() || statement.isThrowStmt();
            boolean switchExpression = statement.getChildNodes().stream()
                .filter(node -> node instanceof Expression)
                .anyMatch(node -> node.findFirst(SwitchExpr.class).isPresent());
            if (switchExpression) {
                return opaque(statement, terminal ? statement.isThrowStmt() ? exceptionTo : returnTo : next,
                    "switch-выражение сохраняется целиком; его внутренний поток пока не раскрывается.");
            }
            if (statement.isBlockStmt()) {
                return block(statement.asBlockStmt(), next, "block", "Блок, строка "
                    + statement.getBegin().orElseThrow().line);
            }
            if (statement instanceof TryStmt attempt) return tryStatement(attempt, next);
            if (statement.isIfStmt()) {
                IfStmt branch = statement.asIfStmt();
                String id = add("condition", branch.getCondition().toString(), branch.getCondition());
                connect(id, branch(branch, false, next), "Да");
                connect(id, branch(branch, true, next), "Нет");
                return new Flow(id, false);
            }
            if (statement instanceof WhileStmt loop) {
                String condition = add("condition", loop.getCondition().toString(), loop.getCondition());
                Flow repeat = new Flow(condition, true);
                controls.push(new Control(next, repeat));
                Flow body = loopBody(loop, repeat, "while");
                controls.pop();
                connect(condition, body, "Да");
                connect(condition, next, "Нет");
                return new Flow(condition, false);
            }
            if (statement instanceof ForStmt loop) {
                Node origin = loop.getCompare().isPresent() ? loop.getCompare().orElseThrow() : loop;
                String condition = add("condition", loop.getCompare().map(Object::toString).orElse("true"), origin);
                Flow update = controlExpressions(loop.getUpdate(), new Flow(condition, true));
                controls.push(new Control(next, update));
                Flow body = loopBody(loop, update, "for");
                controls.pop();
                connect(condition, body, "Да");
                if (loop.getCompare().isPresent()) connect(condition, next, "Нет");
                return controlExpressions(loop.getInitialization(), new Flow(condition, false));
            }
            if (statement instanceof DoStmt loop) {
                String condition = add("condition", loop.getCondition().toString(), loop.getCondition());
                Flow test = new Flow(condition, false);
                controls.push(new Control(next, test));
                Flow body = loopBody(loop, test, "do/while");
                controls.pop();
                connect(condition, new Flow(body.id(), true), "Да");
                connect(condition, next, "Нет");
                return body;
            }
            if (statement instanceof ForEachStmt loop) {
                String condition = add("condition", "Есть следующий элемент?", loop);
                String binding = add("control", "Следующий элемент → " + loop.getVariable(), loop.getVariable());
                Flow repeat = new Flow(condition, true);
                controls.push(new Control(next, repeat));
                Flow body = loopBody(loop, repeat, "foreach");
                controls.pop();
                connect(binding, body, "");
                connect(condition, new Flow(binding, false), "Да");
                connect(condition, next, "Нет");
                String setup = add("control", "Начать обход: " + loop.getIterable(), loop.getIterable());
                connect(setup, new Flow(condition, false), "");
                return new Flow(setup, false);
            }
            if (statement instanceof SwitchStmt selection) {
                boolean supported = selection.getEntries().stream().allMatch(entry ->
                    entry.getGuard().isEmpty() && entry.getLabels().stream().noneMatch(label -> label instanceof PatternExpr)
                    && (entry.getType() == SwitchEntry.Type.STATEMENT_GROUP
                        || entry.getType() == SwitchEntry.Type.BLOCK));
                if (!supported) return opaque(statement, next, "Эта форма switch (шаблон, guard или стрелка без блока) пока не раскрывается.");
                Flow[] starts = new Flow[selection.getEntries().size()];
                Flow following = next;
                controls.push(new Control(next, null));
                for (int i = selection.getEntries().size() - 1; i >= 0; i--) {
                    SwitchEntry entry = selection.getEntry(i);
                    String label = caseLabel(entry) + ", строка " + entry.getBegin().orElseThrow().line;
                    if (entry.getType() == SwitchEntry.Type.BLOCK) {
                        starts[i] = block(entry.getStatement(0).asBlockStmt(), next, "case", label);
                    } else {
                        register(new Sequence(entry, false, "case", label));
                        starts[i] = sequence(entry.getStatements(), following);
                    }
                    following = starts[i];
                }
                controls.pop();
                String id = add("dispatch", selection.getSelector().toString(), selection.getSelector());
                boolean hasDefault = false;
                for (int i = 0; i < starts.length; i++) {
                    SwitchEntry entry = selection.getEntry(i);
                    hasDefault |= entry.isDefault() || entry.getLabels().isEmpty();
                    connect(id, starts[i], caseLabel(entry));
                }
                if (!hasDefault) connect(id, next, "Нет совпадений");
                return new Flow(id, false);
            }
            if (statement.isBreakStmt() && statement.asBreakStmt().getLabel().isEmpty() && !controls.isEmpty()) {
                String id = add("jump", "break;", statement);
                connect(id, controls.peek().breakTo(), "Выход");
                return new Flow(id, false);
            }
            if (statement.isContinueStmt() && statement.asContinueStmt().getLabel().isEmpty()) {
                for (Control control : controls) {
                    if (control.continueTo() == null) continue;
                    String id = add("jump", "continue;", statement);
                    connect(id, control.continueTo(), "Продолжить");
                    return new Flow(id, false);
                }
            }
            boolean simple = isEditableOperation(statement);
            String kind = terminal ? "return" : simple ? "operation" : "opaque";
            String code = statement.getTokenRange().map(Object::toString).orElse(statement.toString());
            String id = add(kind, code, statement);
            if (!simple) {
                notices.add("Конструкция в строке " + statement.getBegin().orElseThrow().line
                    + " показана целиком: внутренний поток управления пока не раскрыт.");
            }
            connect(id, terminal ? statement.isThrowStmt() ? exceptionTo : returnTo : next,
                simple ? "" : "При продолжении");
            return new Flow(id, false);
        }

        Flow tryStatement(TryStmt attempt, Flow next) {
            if (!attempt.getResources().isEmpty()) {
                return opaque(attempt, next, "try-with-resources сохраняется целиком; закрытие ресурсов пока не раскрывается.");
            }
            Flow outerReturn = returnTo;
            Flow outerException = exceptionTo;
            List<Control> outerControls = new ArrayList<>(controls);
            Flow normal = next;
            Flow exceptional = outerException;
            if (attempt.getFinallyBlock().isPresent()) {
                String frame = " [finally L" + attempt.getBegin().orElseThrow().line
                    + ":" + attempt.getBegin().orElseThrow().column + "]";
                String resume = add("completion", "Продолжить ожидающий переход", attempt);
                // Finally runs under the outer context: an abrupt completion here
                // replaces the saved return/throw/break/continue, as in Java.
                Flow cleanup = block(attempt.getFinallyBlock().orElseThrow(),
                    new Flow(resume, false), "finally", "finally, строка " + attempt.getBegin().orElseThrow().line);
                connect(resume, next, "Если ожидается: normal" + frame);
                connect(resume, outerReturn, "Если ожидается: return" + frame);
                connect(resume, outerException, "Если ожидается: throw" + frame);
                normal = new Flow(cleanup.id(), cleanup.backEdge(), "normal" + frame);
                returnTo = new Flow(cleanup.id(), cleanup.backEdge(), "return" + frame);
                exceptional = new Flow(cleanup.id(), cleanup.backEdge(), "throw" + frame);
                controls.clear();
                for (int i = 0; i < outerControls.size(); i++) {
                    Control control = outerControls.get(i);
                    String breakKind = "break-" + i + frame;
                    connect(resume, control.breakTo(), "Если ожидается: " + breakKind);
                    Flow breakTo = new Flow(cleanup.id(), cleanup.backEdge(), breakKind);
                    Flow continueTo = null;
                    if (control.continueTo() != null) {
                        String continueKind = "continue-" + i + frame;
                        connect(resume, control.continueTo(), "Если ожидается: " + continueKind);
                        continueTo = new Flow(cleanup.id(), cleanup.backEdge(), continueKind);
                    }
                    controls.addLast(new Control(breakTo, continueTo));
                }
                notices.add("У каждого finally свой ожидающий переход: исходящие рёбра узла продолжения "
                    + "зависят от сохранённого normal/return/throw/break/continue; это не свободный выбор ветки.");
            }
            exceptionTo = exceptional;
            String handler = add("exception", "Выбрать обработчик исключения", attempt);
            for (CatchClause caught : attempt.getCatchClauses()) {
                Flow body = block(caught.getBody(), normal, "catch", "catch (" + caught.getParameter() + ")");
                connect(handler, body, "Первый подходящий: " + caught.getParameter().getType());
            }
            connect(handler, exceptional, "Не перехвачено");
            exceptionTo = new Flow(handler, false);
            Flow body = block(attempt.getTryBlock(), normal, "try", "try, строка " + attempt.getBegin().orElseThrow().line);
            returnTo = outerReturn;
            exceptionTo = outerException;
            controls.clear();
            controls.addAll(outerControls);
            String entry = add("exception", "try", attempt);
            connect(entry, body, "");
            notices.add("Рёбра исключений — возможные пути: выбор первого подходящего catch происходит "
                + "во время выполнения Java; типы исключений статически не доказываются.");
            return new Flow(entry, false);
        }

        String caseLabel(SwitchEntry entry) {
            if (entry.isDefault() || entry.getLabels().isEmpty()) return "default";
            return "case " + String.join(", ", entry.getLabels().stream().map(Object::toString).toList());
        }

        Flow opaque(Statement statement, Flow next, String message) {
            String id = add("opaque", statement.getTokenRange().map(Object::toString).orElse(statement.toString()), statement);
            notices.add("Строка " + statement.getBegin().orElseThrow().line + ": " + message);
            connect(id, next, "При продолжении");
            return new Flow(id, false);
        }

        String add(String kind, String code, Node origin) {
            String id = methodId + "-" + nodes.size();
            origins.put(id, origin);
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("id", id); node.put("kind", kind); node.put("code", code);
            node.put("range", location(origin));
            node.put("editable", !kind.equals("opaque") && (origin instanceof Statement statement && isEditableOperation(statement)
                || (kind.equals("condition") || kind.equals("dispatch")) && origin instanceof Expression));
            Sequence container = origin instanceof Statement statement ? owners.get(statement) : null;
            if (container != null) {
                node.put("containerId", container.id);
                node.put("index", container.indexOf(origin));
            }
            nodes.add(node);
            if (exceptionTo != null && !exceptionTo.id().equals(exit)
                    && Set.of("operation", "condition", "control", "dispatch", "return").contains(kind)) {
                connect(id, exceptionTo, "При исключении (возможный путь)");
            }
            return id;
        }

        static boolean isEditableOperation(Statement statement) {
            return statement.isExpressionStmt() || statement.isReturnStmt() || statement.isThrowStmt()
                || statement.isEmptyStmt() || statement.isAssertStmt()
                || statement.isBreakStmt() && statement.asBreakStmt().getLabel().isEmpty()
                || statement.isContinueStmt() && statement.asContinueStmt().getLabel().isEmpty();
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
            if (!isEditableOperation(value)) {
                throw new EditRejected("Здесь поддерживается одна операция; структуры управления редактируются отдельно.");
            }
            return value;
        }

        void edit(JsonObject request, JavaParser parser) {
            String action = request.get("action").getAsString();
            if (action.equals("delete") || action.equals("move")) {
                Node target = request.has("nodeId") ? origins.get(request.get("nodeId").getAsString()) : null;
                Sequence container = target instanceof Statement statement ? owners.get(statement) : null;
                if (container == null || !(target instanceof Statement statement) || !isEditableOperation(statement)) {
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
            if (metadata.get().get("kind").equals("condition") || metadata.get().get("kind").equals("dispatch")) {
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
                    container.validateJumps(replacement);
                }
                target.replace(replacement);
            }
        }

        static final class Sequence {
            String id;
            final Node owner;
            final boolean otherwise;
            final String kind;
            final String label;

            Sequence(Node owner, boolean otherwise, String kind, String label) {
                this.owner = owner; this.otherwise = otherwise;
                this.kind = kind; this.label = label;
            }

            List<Statement> statements() {
                if (owner instanceof BlockStmt block) return block.getStatements();
                if (owner instanceof SwitchEntry entry) return entry.getStatements();
                Statement statement;
                if (owner instanceof NodeWithBody<?> loop) statement = loop.getBody();
                else {
                    IfStmt branch = (IfStmt) owner;
                    statement = otherwise ? branch.getElseStmt().orElse(null) : branch.getThenStmt();
                }
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
                    Statement statement = statements.get(i);
                    if (statement.isReturnStmt() || statement.isThrowStmt() || statement.isBreakStmt() || statement.isContinueStmt()) {
                        throw new EditRejected("После return, throw, break или continue нельзя размещать операции в той же последовательности.");
                    }
                }
            }

            void write(List<Statement> statements, JavaParser parser) {
                validate(statements);
                for (Statement statement : statements) validateJumps(statement);
                if (owner instanceof BlockStmt block) block.setStatements(new NodeList<>(statements));
                else if (owner instanceof SwitchEntry entry) entry.setStatements(new NodeList<>(statements));
                else if (owner instanceof NodeWithBody<?> loop) loop.setBody(new BlockStmt(new NodeList<>(statements)));
                else {
                    IfStmt branch = (IfStmt) owner;
                    if (otherwise && branch.getElseStmt().isEmpty()) { addElse(statements, parser); return; }
                    BlockStmt replacement = new BlockStmt(new NodeList<>(statements));
                    if (otherwise) branch.setElseStmt(replacement); else branch.setThenStmt(replacement);
                }
            }

            void addElse(List<Statement> statements, JavaParser parser) {
                IfStmt branch = (IfStmt) owner;
                // Avoid JavaParser 3.27.1's CsmIndent failure when introducing else.
                // Keep existing tokens, including formatting of untouched nested methods.
                String original = branch.getTokenRange().orElseThrow().toString();
                if (!branch.getThenStmt().isBlockStmt()) {
                    StringBuilder prefix = new StringBuilder();
                    var beginning = branch.getThenStmt().getTokenRange().orElseThrow().getBegin();
                    for (var token : branch.getTokenRange().orElseThrow()) {
                        if (token == beginning) break;
                        prefix.append(token.getText());
                    }
                    // Braces prevent a new outer else from attaching to a nested if.
                    original = prefix + "{\n" + branch.getThenStmt().getTokenRange().orElseThrow() + "\n}";
                }
                StringBuilder body = new StringBuilder();
                for (Statement statement : statements) {
                    body.append(statement.getTokenRange().map(Object::toString).orElse(statement.toString())).append('\n');
                }
                var parsed = parser.parseStatement(original + " else {\n" + body + "}");
                if (!parsed.isSuccessful() || parsed.getResult().isEmpty()) {
                    throw new EditRejected("Не удалось дополнить ветку if/else.");
                }
                Statement replacement = parsed.getResult().orElseThrow();
                LexicalPreservingPrinter.setup(replacement);
                branch.replace(replacement);
            }

            void validateJumps(Statement statement) {
                if (!statement.isBreakStmt() && !statement.isContinueStmt()) return;
                boolean needsLoop = statement.isContinueStmt();
                for (Node parent = owner; parent != null; parent = parent.getParentNode().orElse(null)) {
                    if (parent instanceof CallableDeclaration<?> || parent instanceof LambdaExpr) break;
                    if (parent instanceof WhileStmt || parent instanceof DoStmt || parent instanceof ForStmt
                            || parent instanceof ForEachStmt || !needsLoop && parent instanceof SwitchStmt) return;
                }
                throw new EditRejected(needsLoop ? "continue допустим только внутри цикла." : "break допустим только внутри цикла или switch.");
            }

            Map<String, Object> publicData() {
                return Map.of("id", id, "kind", kind, "label", label, "size", statements().size());
            }
        }

        void connect(String from, Flow to, String label) {
            edges.add(Map.of("id", "edge-" + edges.size(), "source", from,
                "target", to.id(), "label", label + (to.completion().isEmpty() ? "" : " · ожидать " + to.completion()),
                "backEdge", to.backEdge()));
        }
    }
}
