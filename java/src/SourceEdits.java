import com.github.javaparser.ast.Node;

/** Verify source coordinates before applying targeted transformations. */
final class SourceEdits {
    static String text(String source, Node node) {
        var r = node.getRange().orElseThrow();
        String text = source.substring(offset(source, r.begin.line, r.begin.column), offset(source, r.end.line, r.end.column)+1);
        if (!text.equals(node.getTokenRange().orElseThrow().toString()))
            throw new IllegalArgumentException("Не удалось точно сопоставить диапазон с исходником. Преобразование отменено.");
        return text;
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
