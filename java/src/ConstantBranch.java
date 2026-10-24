import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import java.util.*;

/** A source-preserving, explicitly bounded transformation of one literal if. */
public final class ConstantBranch {
    record Change(String source, String before, String after, Map<String, Integer> range) {}

    static Optional<Boolean> literal(Node node) {
        if (!(node instanceof Expression expression)) return Optional.empty();
        while (expression instanceof EnclosedExpr enclosed) expression = enclosed.getInner();
        return expression instanceof BooleanLiteralExpr value ? Optional.of(value.getValue()) : Optional.empty();
    }

    static boolean supportedCondition(Node node) {
        return node != null && node.getParentNode().orElse(null) instanceof IfStmt branch
            && branch.getCondition() == node && literal(node).isPresent();
    }

    static Change apply(String source, Node target) {
        if (!supportedCondition(target)) throw new IllegalArgumentException(
            "Поддержаны только условия if с буквальным true или false, включая скобки.");
        IfStmt branch = (IfStmt) target.getParentNode().orElseThrow();
        for (Node parent = branch.getParentNode().orElse(null); parent != null;
                parent = parent.getParentNode().orElse(null)) {
            if (parent instanceof CallableDeclaration<?>) break;
            if (parent instanceof TryStmt) throw new IllegalArgumentException(
                "Упрощение внутри try/catch/finally требует проверки достижимости обработчиков и пока не поддержано.");
        }
        Statement chosen = literal(target).orElseThrow() ? branch.getThenStmt() : branch.getElseStmt().orElse(null);
        if (chosen != null) {
            boolean jumps = chosen.findAll(Statement.class).stream().anyMatch(s -> s instanceof ReturnStmt
                || s instanceof ThrowStmt || s instanceof BreakStmt || s instanceof ContinueStmt);
            boolean infiniteLoop = chosen.findAll(Statement.class).stream().anyMatch(s ->
                s instanceof ForStmt loop && (loop.getCompare().isEmpty() || literal(loop.getCompare().orElseThrow()).orElse(false))
                || s instanceof WhileStmt whileLoop && literal(whileLoop.getCondition()).orElse(false)
                || s instanceof DoStmt doLoop && literal(doLoop.getCondition()).orElse(false));
            if (jumps || infiniteLoop) throw new IllegalArgumentException(
                "Выбранная ветка содержит переход управления или безусловный цикл. Для сохранения достижимости такое упрощение пока не поддержано.");
        }
        String after = chosen == null ? "{}" : chosen.getTokenRange().orElseThrow().toString();
        if (chosen != null && !chosen.isBlockStmt()) after = "{\n" + after + "\n}";
        var range = branch.getRange().orElseThrow();
        int start = offset(source, range.begin.line, range.begin.column);
        int end = offset(source, range.end.line, range.end.column) + 1;
        String before = branch.getTokenRange().orElseThrow().toString();
        if (!source.substring(start, end).equals(before)) throw new IllegalArgumentException(
            "Не удалось точно сопоставить ветку с исходником. Преобразование отменено.");
        return new Change(source.substring(0, start) + after + source.substring(end), before, after,
            BlueprintParser.location(branch));
    }

    static int offset(String source, int line, int column) {
        int index = 0;
        for (int current = 1; current < line; current++) {
            while (index < source.length() && source.charAt(index) != '\n' && source.charAt(index) != '\r') index++;
            if (index < source.length() && source.charAt(index++) == '\r'
                    && index < source.length() && source.charAt(index) == '\n') index++;
        }
        return index + column - 1;
    }
}
