import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.stmt.*;
import com.github.javaparser.ast.expr.*;
import java.util.*;

/** Bounded syntactic rules; no execution, symbol resolution or model service. */
public final class BlueprintAnalyzer {
    static final int LONG_METHOD_LINES = 40;
    static final int DEEP_NESTING = 3;

    @SuppressWarnings("unchecked")
    static Map<String, Object> analyze(CompilationUnit unit, Map<String, Object> parsed) {
        List<Map<String, Object>> findings = new ArrayList<>();
        List<Map<String, Object>> methods = new ArrayList<>();
        Map<String, Object> graphs = (Map<String, Object>) parsed.get("graphs");
        for (Node node : unit.findAll(Node.class)) {
            if (!(node instanceof MethodDeclaration) && !(node instanceof ConstructorDeclaration)) continue;
            var callable = (CallableDeclaration<?>) node;
            String id = BlueprintParser.methodId(node);
            var graph = (Map<String, Object>) graphs.get(id);
            Optional<BlockStmt> body = node instanceof MethodDeclaration m ? m.getBody()
                : Optional.of(((ConstructorDeclaration) node).getBody());
            if (body.isEmpty()) continue;
            if (node.getEnd().orElseThrow().line - node.getBegin().orElseThrow().line + 1 > LONG_METHOD_LINES) {
                findings.add(finding("long-method", "Длина метода превышает 40 строк.",
                    "Рассмотрите выделение связанных операций в отдельные методы.", node, id, graph));
            }
            for (Statement statement : body.get().findAll(Statement.class)) {
                if (!belongsToMethod(statement, callable)) continue;
                int depth = 0;
                boolean outerLoop = false;
                for (Node parent = statement.getParentNode().orElse(null); parent != null && parent != body.get();
                        parent = parent.getParentNode().orElse(null)) {
                    if (control(parent)) depth++;
                    if (loop(parent)) outerLoop = true;
                }
                if (control(statement) && depth + 1 == DEEP_NESTING) {
                    findings.add(finding("deep-nesting", "Вложенность управляющих конструкций достигла 3 уровней.",
                        "Рассмотрите ранний выход или выделение вложенной логики в метод.", statement, id, graph));
                }
                if (loop(statement) && outerLoop) {
                    findings.add(finding("nested-loops", "Цикл расположен внутри другого цикла. Это может увеличивать стоимость выполнения.",
                        "Проверьте объём повторной работы; вложенность сама по себе не доказывает O(n²).", statement, id, graph));
                }
                if (statement instanceof IfStmt branch) {
                    Expression condition = branch.getCondition();
                    while (condition instanceof EnclosedExpr enclosed) condition = enclosed.getInner();
                    if (condition instanceof BooleanLiteralExpr literal) {
                        findings.add(finding("constant-condition", "Условие if всегда равно " + literal.getValue() + ".",
                            "Проверьте намерение и рассмотрите упрощение ветвления с сохранением области видимости.",
                            branch.getCondition(), id, graph));
                    }
                }
            }
            methods.add(Map.of("methodId", id, "signature", callable.getSignature().asString(),
                "range", BlueprintParser.location(node), "complexity", complexity(callable, body.get())));
        }
        return Map.of("findings", findings, "methods", methods,
            "thresholds", Map.of("longMethodLines", LONG_METHOD_LINES, "deepNesting", DEEP_NESTING));
    }

    static boolean belongsToMethod(Node statement, CallableDeclaration<?> method) {
        for (Node parent = statement.getParentNode().orElse(null); parent != null;
                parent = parent.getParentNode().orElse(null)) {
            if (parent == method) return true;
            if (parent instanceof LambdaExpr || parent instanceof TypeDeclaration<?>
                    || parent instanceof CallableDeclaration<?>
                    || parent instanceof ObjectCreationExpr creation && creation.getAnonymousClassBody().isPresent()) return false;
        }
        return false;
    }

    static boolean loop(Node node) {
        return node instanceof ForStmt || node instanceof ForEachStmt || node instanceof WhileStmt || node instanceof DoStmt;
    }

    static boolean control(Node node) {
        return loop(node) || node instanceof IfStmt || node instanceof SwitchStmt
            || node instanceof TryStmt || node instanceof SynchronizedStmt;
    }

    static Map<String, Object> unknown(String reason) {
        return Map.of("label", "не определена", "explanation", reason, "assumptions", List.of());
    }

    static Map<String, Object> complexity(CallableDeclaration<?> callable, BlockStmt body) {
        if (callable instanceof ConstructorDeclaration)
            return unknown("Стоимость неявного super() и инициализаторов экземпляра не определена.");
        if (!body.findAll(MethodCallExpr.class).isEmpty())
            return unknown("Стоимость вызовов неизвестна без анализа вызываемого кода, включая рекурсивные вызовы.");
        Set<String> scalars = new HashSet<>();
        Set<String> arrays = new HashSet<>();
        for (var parameter : callable.getParameters()) {
            if (parameter.isVarArgs()) return unknown("Параметры переменной длины пока не поддержаны оценкой.");
            if (parameter.getType().isPrimitiveType()) scalars.add(parameter.getNameAsString());
            else if (parameter.getType().isArrayType()
                    && parameter.getType().asArrayType().getComponentType().isPrimitiveType()) arrays.add(parameter.getNameAsString());
            else return unknown("Стоимость операций с объектными параметрами не определена этим анализатором.");
        }
        Set<String> names = new HashSet<>(scalars); names.addAll(arrays);
        for (var variable : body.findAll(VariableDeclarator.class)) {
            if (!variable.getType().isPrimitiveType()) return unknown("Объектные локальные переменные пока не поддержаны оценкой.");
            names.add(variable.getNameAsString());
        }
        // Shadowed bindings need symbol resolution, which this conservative estimator does not perform.
        if (body.findAll(VariableDeclarator.class).stream().map(v -> v.getNameAsString()).distinct().count()
                != body.findAll(VariableDeclarator.class).size()) return unknown("Повторяющиеся имена требуют разрешения областей видимости.");
        for (Statement statement : body.findAll(Statement.class)) {
            if (!(statement instanceof BlockStmt || statement instanceof ExpressionStmt || statement instanceof ReturnStmt
                    || statement instanceof IfStmt || statement instanceof ForStmt || statement instanceof EmptyStmt))
                return unknown("Эта управляющая конструкция пока не поддержана оценкой сложности.");
        }
        for (Expression expression : body.findAll(Expression.class)) {
            if (!(expression instanceof NameExpr || expression instanceof IntegerLiteralExpr || expression instanceof LongLiteralExpr
                    || expression instanceof DoubleLiteralExpr || expression instanceof BooleanLiteralExpr || expression instanceof CharLiteralExpr
                    || expression instanceof BinaryExpr || expression instanceof UnaryExpr || expression instanceof AssignExpr
                    || expression instanceof VariableDeclarationExpr || expression instanceof EnclosedExpr || expression instanceof CastExpr
                    || expression instanceof ConditionalExpr || expression instanceof ArrayAccessExpr || expression instanceof FieldAccessExpr))
                return unknown("Выражение имеет неизвестную стоимость или не входит в поддержанный набор.");
            if (expression instanceof NameExpr name && !names.contains(name.getNameAsString()))
                return unknown("Стоимость обращения к полю или неизвестной переменной не определена.");
            if (expression instanceof FieldAccessExpr field && !(field.getNameAsString().equals("length")
                    && field.getScope() instanceof NameExpr name && arrays.contains(name.getNameAsString())))
                return unknown("Стоимость обращения к объекту не определена.");
            if (expression instanceof CastExpr cast && !cast.getType().isPrimitiveType())
                return unknown("Приведения к объектным типам пока не поддержаны оценкой.");
        }
        Map<ForStmt, String> bounds = new IdentityHashMap<>();
        for (ForStmt cycle : body.findAll(ForStmt.class)) {
            if (cycle.getInitialization().size() != 1 || cycle.getUpdate().size() != 1
                    || !(cycle.getInitialization().get(0) instanceof VariableDeclarationExpr declaration)
                    || declaration.getVariables().size() != 1) return unknown("Поддержаны только счётные for с одной переменной.");
            var variable = declaration.getVariable(0);
            if (!variable.getType().asString().equals("int") || variable.getInitializer().isEmpty()
                    || !variable.getInitializer().get().toString().equals("0")) return unknown("Поддержан счётчик int от нуля с шагом +1.");
            String index = variable.getNameAsString();
            if (!(cycle.getUpdate().get(0) instanceof UnaryExpr update)
                    || !(update.getOperator() == UnaryExpr.Operator.POSTFIX_INCREMENT || update.getOperator() == UnaryExpr.Operator.PREFIX_INCREMENT)
                    || !update.getExpression().toString().equals(index)) return unknown("Шаг цикла не соответствует поддержанному +1.");
            if (cycle.getCompare().isEmpty() || !(cycle.getCompare().get() instanceof BinaryExpr compare)
                    || compare.getOperator() != BinaryExpr.Operator.LESS || !compare.getLeft().toString().equals(index))
                return unknown("Поддержано условие счётчика вида i < граница.");
            Expression bound = compare.getRight();
            String factor;
            if (bound instanceof NameExpr name && scalars.contains(name.getNameAsString())
                    && callable.getParameterByName(name.getNameAsString()).orElseThrow().getType().asString().equals("int")) factor = name.getNameAsString();
            else if (bound instanceof FieldAccessExpr field && field.getNameAsString().equals("length")
                    && field.getScope() instanceof NameExpr name && arrays.contains(name.getNameAsString())) factor = field.toString();
            else if (bound instanceof IntegerLiteralExpr literal) {
                try { if (literal.asNumber().longValue() < 0 || literal.asNumber().longValue() > Integer.MAX_VALUE) return unknown("Граница вне диапазона int."); }
                catch (RuntimeException error) { return unknown("Не удалось определить числовую границу."); }
                factor = "";
            } else return unknown("Зависимая или вычисляемая граница цикла требует отдельного анализа.");
            if (writes(body, index) != 1) return unknown("Счётчик изменяется вне стандартного шага цикла.");
            String boundName = bound instanceof FieldAccessExpr field ? field.getScope().toString() : bound.toString();
            if (writes(body, boundName) != 0) return unknown("Граница цикла изменяется внутри метода.");
            bounds.put(cycle, factor);
        }
        // A sum of per-path monomials is a safe upper bound for sequential and nested loops.
        Set<String> terms = new TreeSet<>();
        int maxDegree = 0;
        for (ForStmt cycle : bounds.keySet()) {
            Map<String, Integer> factors = new TreeMap<>();
            for (Node parent = cycle; parent != null && parent != body; parent = parent.getParentNode().orElse(null)) {
                if (parent instanceof ForStmt outer && !bounds.get(outer).isEmpty()) factors.merge(bounds.get(outer), 1, Integer::sum);
            }
            maxDegree = Math.max(maxDegree, factors.values().stream().mapToInt(Integer::intValue).sum());
            if (!factors.isEmpty()) terms.add(String.join(" · ", factors.entrySet().stream()
                .map(e -> e.getKey() + (e.getValue() == 1 ? "" : e.getValue() == 2 ? "²" : e.getValue() == 3 ? "³" : "^" + e.getValue())).toList()));
        }
        // Drop lower powers when there is only one size variable.
        Set<String> distinctBounds = new HashSet<>(bounds.values()); distinctBounds.remove("");
        if (distinctBounds.size() == 1 && terms.size() > 1) {
            String dominant = distinctBounds.iterator().next()
                + (maxDegree == 1 ? "" : maxDegree == 2 ? "²" : maxDegree == 3 ? "³" : "^" + maxDegree);
            terms = new TreeSet<>(List.of(dominant));
        }
        return Map.of("label", terms.isEmpty() ? "O(1)" : "O(" + String.join(" + ", terms) + ")",
            "explanation", "Верхняя оценка числа операций для поддержанных последовательностей, if и счётных for.",
            "assumptions", List.of("Размеры входов неотрицательны; параметры и границы циклов не изменяются.",
                "Операции над примитивами и индексирование массивов считаются O(1); переполнение и ошибки выполнения не моделируются.",
                "Это оценка текущего кода, а не обещание ускорения после преобразования."));
    }

    static Expression unwrap(Expression expression) {
        while (expression instanceof EnclosedExpr enclosed) expression = enclosed.getInner();
        return expression;
    }

    static int writes(BlockStmt body, String name) {
        int count = 0;
        for (AssignExpr assign : body.findAll(AssignExpr.class)) if (unwrap(assign.getTarget()).toString().equals(name)) count++;
        for (UnaryExpr unary : body.findAll(UnaryExpr.class)) {
            if (Set.of(UnaryExpr.Operator.POSTFIX_INCREMENT, UnaryExpr.Operator.PREFIX_INCREMENT,
                    UnaryExpr.Operator.POSTFIX_DECREMENT, UnaryExpr.Operator.PREFIX_DECREMENT).contains(unary.getOperator())
                    && unwrap(unary.getExpression()).toString().equals(name)) count++;
        }
        return count;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> finding(String rule, String message, String recommendation,
            Node origin, String methodId, Map<String, Object> graph) {
        var range = BlueprintParser.location(origin);
        var anchor = origin instanceof IfStmt branch ? BlueprintParser.location(branch.getCondition()) : range;
        String nodeId = "";
        long best = Long.MAX_VALUE;
        for (var block : (List<Map<String, Object>>) graph.get("nodes")) {
            if (block.get("kind").equals("exit")) continue;
            var r = (Map<String, Integer>) block.get("range");
            long start = r.get("startLine") * 1000000L + r.get("startColumn");
            long end = r.get("endLine") * 1000000L + r.get("endColumn");
            long point = anchor.get("startLine") * 1000000L + anchor.get("startColumn");
            if (start <= point && point <= end && end - start < best) {
                nodeId = (String) block.get("id"); best = end - start;
            }
        }
        return Map.of("rule", rule, "message", message, "recommendation", recommendation,
            "methodId", methodId, "nodeId", nodeId, "range", range);
    }

}
