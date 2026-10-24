import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import com.google.gson.JsonObject;
import javax.lang.model.SourceVersion;
import java.util.*;

/** Conservative extraction of a straight-line primitive fragment; no type guesses. */
public final class ExtractMethod {
    record Variable(String type, boolean initialized, boolean immutable) {}
    record Change(String source, Map<String, Object> preview) {}

    static IllegalArgumentException reject(String message) { return new IllegalArgumentException(message); }

    static Change apply(String source, Node declaration, JsonObject request) {
        if (!(declaration instanceof MethodDeclaration method) || method.getBody().isEmpty()
                || !(method.getParentNode().orElse(null) instanceof ClassOrInterfaceDeclaration owner)
                || owner.isInterface() || !owner.getExtendedTypes().isEmpty() || !owner.getImplementedTypes().isEmpty())
            throw reject("Поддержаны методы обычного класса без extends/implements; конструкторы и интерфейсы пока не поддержаны.");
        String name = request.get("methodName").getAsString();
        if (!name.matches("[A-Za-z_][A-Za-z0-9_]*") || !SourceVersion.isIdentifier(name)
                || SourceVersion.isKeyword(name) || Set.of("yield", "toString", "hashCode", "equals", "clone", "finalize", "wait", "notify", "notifyAll", "getClass").contains(name))
            throw reject("Выберите допустимое имя метода латиницей: ключевые слова, yield и имена методов Object не поддержаны.");
        if (!owner.getMethodsByName(name).isEmpty() || owner.findAll(MethodCallExpr.class).stream().anyMatch(call -> call.getNameAsString().equals(name)))
            throw reject("Это имя уже используется методом или вызовом. Выберите другое имя.");
        List<Statement> body = method.getBody().orElseThrow().getStatements();
        int start = request.get("startIndex").getAsInt(), end = request.get("endIndex").getAsInt();
        if (start < 0 || end <= start || end > body.size()) throw reject("Выберите непустую непрерывную последовательность в теле метода.");
        List<Statement> selected = body.subList(start, end);
        Map<String, Variable> available = new LinkedHashMap<>();
        for (var parameter : method.getParameters()) {
            String type = parameter.isVarArgs() ? "" : primitive(parameter.getType());
            available.put(parameter.getNameAsString(), new Variable(type, true, parameter.isFinal()));
        }
        for (Statement statement : body.subList(0, start)) {
            if (statement instanceof ExpressionStmt expression && expression.getExpression() instanceof VariableDeclarationExpr variables) {
                for (var variable : variables.getVariables()) available.put(variable.getNameAsString(),
                    new Variable(primitive(variable.getType()), variable.getInitializer().isPresent(), variables.isFinal()));
            }
        }
        Map<String, Variable> locals = new LinkedHashMap<>();
        Map<String, VariableDeclarationExpr> declarations = new HashMap<>();
        for (Statement statement : selected) {
            if (!(statement instanceof ExpressionStmt expression))
                throw reject("Выделяются только последовательности объявлений и операций с примитивами; ветвления, циклы и переходы управления пока не поддержаны.");
            if (expression.getExpression() instanceof VariableDeclarationExpr variables) {
                if (!variables.getAnnotations().isEmpty() || variables.getVariables().size() != 1)
                    throw reject("Поддержано одно объявление примитивной переменной без аннотаций в операции.");
                var variable = variables.getVariable(0);
                String variableName = variable.getNameAsString(), type = primitive(variable.getType());
                if (type.isEmpty() || variable.getInitializer().isEmpty())
                    throw reject("Нужен явный примитивный тип и инициализатор; var и неизвестные типы не выводятся автоматически.");
                if (available.containsKey(variableName) || locals.containsKey(variableName))
                    throw reject("Повторное имя переменной требует разрешения областей видимости и пока не поддержано.");
                locals.put(variableName, new Variable(type, true, variables.isFinal()));
                declarations.put(variableName, variables);
            }
        }
        Map<String, Variable> inputs = new LinkedHashMap<>();
        Set<String> written = new LinkedHashSet<>();
        for (Statement statement : selected) {
            for (Expression expression : statement.findAll(Expression.class)) {
                if (!(expression instanceof NameExpr || expression instanceof IntegerLiteralExpr || expression instanceof LongLiteralExpr
                        || expression instanceof DoubleLiteralExpr || expression instanceof BooleanLiteralExpr || expression instanceof CharLiteralExpr
                        || expression instanceof BinaryExpr || expression instanceof UnaryExpr || expression instanceof AssignExpr
                        || expression instanceof VariableDeclarationExpr || expression instanceof EnclosedExpr || expression instanceof CastExpr
                        || expression instanceof ConditionalExpr))
                    throw reject("Фрагмент содержит вызов, объект, массив, поле или выражение с неподдержанной зависимостью.");
                if (expression instanceof CastExpr cast && !cast.getType().isPrimitiveType())
                    throw reject("Поддержаны только приведения к примитивным типам.");
                if (expression instanceof NameExpr reference && (!locals.containsKey(reference.getNameAsString())
                        || reference.getBegin().orElseThrow().isBefore(declarations.get(reference.getNameAsString()).getBegin().orElseThrow()))) {
                    String variableName = reference.getNameAsString();
                    Variable variable = available.get(variableName);
                    if (variable == null || variable.type().isEmpty() || !variable.initialized())
                        throw reject("Не определены примитивный тип или инициализация зависимости: " + variableName + ". Поля не захватываются автоматически.");
                    if (variable.immutable() && method.getParameterByName(variableName).isEmpty())
                        throw reject("Локальная final-переменная на входе может быть константой компиляции. Выделение через такую границу пока не поддержано: " + variableName);
                    inputs.putIfAbsent(variableName, variable);
                }
                if (expression instanceof AssignExpr assignment) markWrite(assignment.getTarget(), locals, available, written);
                if (expression instanceof UnaryExpr unary && Set.of(UnaryExpr.Operator.PREFIX_INCREMENT, UnaryExpr.Operator.POSTFIX_INCREMENT,
                        UnaryExpr.Operator.PREFIX_DECREMENT, UnaryExpr.Operator.POSTFIX_DECREMENT).contains(unary.getOperator()))
                    markWrite(unary.getExpression(), locals, available, written);
            }
        }
        int parameterSlots = method.isStatic() ? 0 : 1;
        for (Variable input : inputs.values()) parameterSlots += Set.of("long", "double").contains(input.type()) ? 2 : 1;
        if (parameterSlots > 255) throw reject("Параметры нового метода превышают лимит JVM в 255 слотов, включая this у нестатического метода.");
        Set<String> outputs = new LinkedHashSet<>(written);
        for (Statement statement : body.subList(end, body.size())) {
            for (NameExpr reference : statement.findAll(NameExpr.class)) {
                if (locals.containsKey(reference.getNameAsString())) outputs.add(reference.getNameAsString());
            }
        }
        if (outputs.size() > 1) throw reject("У фрагмента несколько выходных переменных. Поддержано не более одного возвращаемого значения.");
        String output = outputs.stream().findFirst().orElse("");
        Variable result = locals.containsKey(output) ? locals.get(output) : available.get(output);
        if (!output.isEmpty() && locals.containsKey(output) && result.immutable())
            throw reject("Возврат final-переменной может потерять статус константы компиляции. Выберите другой диапазон.");
        String returnType = output.isEmpty() ? "void" : result.type();
        String arguments = String.join(", ", inputs.keySet());
        String parameters = String.join(", ", inputs.entrySet().stream().map(e -> e.getValue().type() + " " + e.getKey()).toList());
        String call = name + "(" + arguments + ");";
        if (!output.isEmpty()) call = (locals.containsKey(output)
            ? result.type() + " " + output : output) + " = " + call;
        int from = SourceEdits.offset(source, selected.get(0).getBegin().orElseThrow().line, selected.get(0).getBegin().orElseThrow().column);
        int to = SourceEdits.offset(source, selected.get(selected.size()-1).getEnd().orElseThrow().line,
            selected.get(selected.size()-1).getEnd().orElseThrow().column) + 1;
        for (Statement statement : selected) SourceEdits.text(source, statement);
        String before = source.substring(from, to);
        String extractedBody = String.join("\n", before.lines().map(line -> "        " + line.stripLeading()).toList());
        String helper = "    private " + (method.isStatic() ? "static " : "") + returnType + " " + name + "(" + parameters + ") {\n"
            + extractedBody + (output.isEmpty() ? "" : "\n        return " + output + ";") + "\n    }";
        int insertion = SourceEdits.offset(source, owner.getEnd().orElseThrow().line, owner.getEnd().orElseThrow().column);
        if (source.charAt(insertion) != '}') throw reject("Не удалось точно определить границу класса; преобразование отменено.");
        String candidate = source.substring(0, from) + call + source.substring(to, insertion) + "\n" + helper + "\n" + source.substring(insertion);
        List<Object> inputMetadata = new ArrayList<>();
        inputs.forEach((key, value) -> inputMetadata.add(Map.of("name", key, "type", value.type())));
        return new Change(candidate, Map.of("before", before, "after", call, "newMethod", helper,
            "parameters", inputMetadata, "returnType", returnType, "outputName", output,
            "range", Map.of("startLine", selected.get(0).getBegin().orElseThrow().line,
                "startColumn", selected.get(0).getBegin().orElseThrow().column,
                "endLine", selected.get(selected.size()-1).getEnd().orElseThrow().line,
                "endColumn", selected.get(selected.size()-1).getEnd().orElseThrow().column)));
    }

    static String primitive(com.github.javaparser.ast.type.Type type) {
        return type.isPrimitiveType() ? type.asPrimitiveType().getType().name().toLowerCase(Locale.ROOT) : "";
    }

    static void markWrite(Expression target, Map<String, Variable> locals, Map<String, Variable> available, Set<String> written) {
        while (target instanceof EnclosedExpr enclosed) target = enclosed.getInner();
        if (!(target instanceof NameExpr name)) throw reject("Поддержана запись только в локальную примитивную переменную.");
        String variableName = name.getNameAsString();
        if (locals.containsKey(variableName)) return;
        Variable variable = available.get(variableName);
        if (variable == null || variable.type().isEmpty() || !variable.initialized() || variable.immutable())
            throw reject("Выходная переменная должна иметь известный примитивный тип, значение и допускать присваивание: " + variableName);
        written.add(variableName);
    }
}
