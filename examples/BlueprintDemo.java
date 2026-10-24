import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.Formatter;
import java.util.Locale;
import java.util.Scanner;

/**
 * Демонстрационный монолит: консоль заказа и каталог исполняемых Java-примеров.
 * Первая строка stdin выбирает сценарий. Без ввода выполняется заказ 250 × 5.
 * Остальные классы находятся в этом же файле и сохраняются при правке метода.
 */
public class BlueprintDemo {

    private static final int DISCOUNT_THRESHOLD = 1000;

    public static int calculateTotal(int amount, int quantity) {
        int subtotal = amount * quantity;
        if (true) {
            subtotal += 0;
        }
        if (subtotal >= DISCOUNT_THRESHOLD) {
            int discount = subtotal / 10;
            return subtotal - discount;
        }
        return subtotal;
    }

    public static int sum(int n) {
        int result = 0;
        for (int i = 0; i < n; i++) {
            result += i;
        }
        return result;
    }

    public static int rectangle(int rows, int columns) {
        int total = 0;
        for (int i = 0; i < rows; i++) {
            for (int j = 0; j < columns; j++) {
                total++;
            }
        }
        return total;
    }

    static void runOrder(Scanner input) {
        int amount = input.hasNextInt() ? input.nextInt() : 250;
        int quantity = input.hasNextInt() ? input.nextInt() : 5;
        if (amount < 0 || quantity < 0) {
            throw new IllegalArgumentException("Цена и количество должны быть неотрицательными");
        }
        if (amount > 100000 || quantity > 1000) {
            throw new IllegalArgumentException("Заказ превышает лимит демонстрационного каталога");
        }
        System.out.println("Итого: " + calculateTotal(amount, quantity));
    }

    static String readCommand() throws IOException {
        StringBuilder command = new StringBuilder();
        int symbol = System.in.read();
        while (symbol != -1 && symbol != '\n') {
            if (symbol != '\r') {
                command.append((char) symbol);
            }
            symbol = System.in.read();
        }
        return command.length() == 0 ? "order" : command.toString().trim();
    }

    public static void main(String[] args) throws Exception {
        String command = readCommand();
        switch(command) {
            case "order":
                {
                    runOrder(new Scanner(System.in, StandardCharsets.UTF_8));
                    break;
                }
            case "sum":
                {
                    System.out.println("Сумма: " + sum(5));
                    break;
                }
            case "rectangle":
                {
                    System.out.println("Клетки: " + rectangle(3, 4));
                    break;
                }
            case "caught":
                {
                    JavaCaught.runExample(args);
                    break;
                }
            case "collections":
                {
                    JavaCollections.runExample(args);
                    break;
                }
            case "console":
                {
                    JavaConsole.runExample(args);
                    break;
                }
            case "declarations":
                {
                    JavaDeclarations.runExample(args);
                    break;
                }
            case "finally-override":
                {
                    JavaFinallyOverride.runExample(args);
                    break;
                }
            case "multi-catch":
                {
                    JavaMultiCatch.runExample(args);
                    break;
                }
            case "nested-cleanup":
                {
                    JavaNestedCleanup.runExample(args);
                    break;
                }
            case "nested-finally":
                {
                    JavaNestedFinally.runExample(args);
                    break;
                }
            case "primitives":
                {
                    JavaPrimitives.runExample(args);
                    break;
                }
            case "uncaught":
                {
                    JavaUncaught.runExample(args);
                    break;
                }
            case "do":
                {
                    ControlDo.runExample(args);
                    break;
                }
            case "for":
                {
                    ControlFor.runExample(args);
                    break;
                }
            case "foreach-array":
                {
                    ControlForeachArray.runExample(args);
                    break;
                }
            case "foreach-list":
                {
                    ControlForeachList.runExample(args);
                    break;
                }
            case "infinite-for":
                {
                    ControlInfiniteFor.runExample(args);
                    break;
                }
            case "nested":
                {
                    ControlNested.runExample(args);
                    break;
                }
            case "return":
                {
                    ControlReturn.runExample(args);
                    break;
                }
            case "switch-arrow":
                {
                    ControlSwitchArrow.runExample(args);
                    break;
                }
            case "switch-colon":
                {
                    ControlSwitchColon.runExample(args);
                    break;
                }
            case "switch-empty-labels":
                {
                    ControlSwitchEmptyLabels.runExample(args);
                    break;
                }
            case "unbraced":
                {
                    ControlUnbraced.runExample(args);
                    break;
                }
            case "while":
                {
                    ControlWhile.runExample(args);
                    break;
                }
            case "stock":
                {
                    StockDemo.runExample(args);
                    break;
                }
            default:
                {
                    throw new IllegalArgumentException("Неизвестная команда: " + command);
                }
        }
    }
}

/**
 * Исполняемый пример: java_coverage/caught.
 */
class Problem extends Exception {

    Problem(String message) {
        super(message);
    }
}

class JavaCaught {

    static int calculate(int value) throws Problem {
        if (value < 0)
            throw new Problem("отрицательное");
        return value;
    }

    static void runExample(String[] args) {
        int value = -1;
        try {
            System.out.println(calculate(value));
        } catch (Problem error) {
            System.out.println("Ошибка: " + error.getMessage());
        } finally {
            System.out.println("Завершено");
        }
    }
}

/**
 * Исполняемый пример: java_coverage/collections.
 */
class JavaCollections {

    static void runExample(String[] args) {
        Collection<Integer> items = new ArrayList<>(List.of(3, 1, 2));
        List<Integer> list = new LinkedList<>(items);
        Collections.sort(list, Comparator.naturalOrder());
        Set<Integer> hash = new HashSet<>(list);
        Set<Integer> linked = new LinkedHashSet<>(list);
        Set<Integer> sorted = new TreeSet<>(hash);
        Map<String, Integer> map = new HashMap<>(Map.of("x", 2));
        Map<String, Integer> linkedMap = new LinkedHashMap<>(map);
        Map<String, Integer> treeMap = new TreeMap<>(linkedMap);
        Iterable<Integer> iterable = sorted;
        Iterator<Integer> iterator = iterable.iterator();
        int total = 0;
        while (iterator.hasNext()) total += iterator.next();
        int[] array = { 3, 1, 2 };
        Arrays.sort(array);
        total += 0;
        System.out.println(list + ":" + linked + ":" + Arrays.toString(array));
        System.out.println(total + treeMap.get("x") + Optional.of(4).orElse(0) + Set.of(8, 9).size());
    }
}

/**
 * Исполняемый пример: java_coverage/console.
 */
class JavaConsole {

    static void runExample(String[] args) {
        Scanner input = new Scanner(System.in, StandardCharsets.UTF_8);
        String name = input.nextLine();
        int number = input.nextInt();
        number += 0;
        Formatter formatter = new Formatter(Locale.ROOT);
        formatter.format("Привет, %s! %d", name, number);
        System.out.println(formatter.toString());
        System.out.printf(Locale.ROOT, "%s%n", String.format(Locale.ROOT, "Сумма: %d", number + 1));
        System.err.println("Диагностика: " + name);
    }
}

/**
 * Исполняемый пример: java_coverage/declarations.
 */
interface Value {

    int get();
}

abstract class Base {

    abstract int get();
}

class Box extends Base implements Value {

    private final int value;

    static int created = 0;

    Box() {
        this(3);
    }

    Box(int value) {
        this.value = value;
        created++;
    }

    public int get() {
        return value;
    }

    int get(int extra) {
        return value + extra;
    }
}

class JavaDeclarations {

    static class Nested {

        static final String LABEL = "коробка";
    }

    static void runExample(String[] args) {
        Box box = new Box();
        Value view = box;
        System.out.println(Nested.LABEL + ":" + view.get() + ":" + box.get(2) + ":" + Box.created);
    }
}

/**
 * Исполняемый пример: java_coverage/finally_override.
 */
class JavaFinallyOverride {

    static int calculate() {
        try {
            return 1;
        } finally {
            return 2;
        }
    }

    static void runExample(String[] args) {
        int value = calculate();
        System.out.println(value);
    }
}

/**
 * Исполняемый пример: java_coverage/multi_catch.
 */
class JavaMultiCatch {

    static void fail() throws IOException {
        throw new IOException("ввод");
    }

    static void runExample(String[] args) {
        int value = 1;
        try {
            try {
                fail();
            } catch (IOException | IllegalArgumentException error) {
                throw new IllegalStateException(error.getMessage());
            } finally {
                System.out.println("первый " + value);
            }
        } catch (RuntimeException error) {
            System.out.println(error.getClass().getSimpleName() + ":" + error.getMessage());
        } finally {
            System.out.println("второй");
        }
    }
}

/**
 * Исполняемый пример: java_coverage/nested_cleanup.
 */
class JavaNestedCleanup {

    static int calculate() {
        try {
            return 3;
        } finally {
            try {
                System.out.println("тело очистки");
            } finally {
                System.out.println("вложенная очистка");
            }
        }
    }

    static void runExample(String[] args) {
        System.out.println(calculate());
    }
}

/**
 * Исполняемый пример: java_coverage/nested_finally.
 */
class JavaNestedFinally {

    static int calculate() {
        try {
            try {
                return 1;
            } finally {
                System.out.println("внутри");
            }
        } finally {
            System.out.println("снаружи");
        }
    }

    static void runExample(String[] args) {
        System.out.println(calculate());
        for (int i = 0; i < 3; i++) {
            try {
                if (i == 0)
                    continue;
                if (i == 1)
                    break;
            } finally {
                System.out.println("шаг " + i);
            }
        }
    }
}

/**
 * Исполняемый пример: java_coverage/primitives.
 */
class JavaPrimitives {

    static void runExample(String[] args) {
        byte b = 2;
        short s = 3;
        int i = 4;
        long l = 5L;
        float f = 1.5f;
        double d = 2.5;
        char c = 'Я';
        boolean ok = true;
        Byte wb = b;
        Short ws = s;
        Integer wi = i;
        Long wl = l;
        Float wf = f;
        Double wd = d;
        Character wc = c;
        Boolean wo = ok;
        int[] values = { wb, ws, wi, wl.intValue() };
        int total = 0;
        for (int value : values) total += value;
        boolean logic = wo && total == 14 && wf < wd && wc == 'Я' || false;
        total += (int) Math.abs(-2.8);
        String text = new StringBuilder().append(c).append(':').append(total).toString();
        Object object = text;
        System.out.println(object.toString() + ":" + logic + ":" + Integer.parseInt("7"));
    }
}

/**
 * Исполняемый пример: java_coverage/uncaught.
 */
class Broken extends RuntimeException {

    Broken(String message) {
        super(message);
    }
}

class JavaUncaught {

    static void runExample(String[] args) {
        int value = 1;
        try {
            throw new Broken("сбой " + value);
        } finally {
            System.out.println("Очистка");
        }
    }
}

/**
 * Исполняемый пример: control_flow/do.
 */
class ControlDo {

    static void runExample(String[] args) {
        int n = 0, total = 0;
        do {
            n++;
            if (n == 1)
                continue;
            total += n;
        } while (n < 3);
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/for.
 */
class ControlFor {

    static void runExample(String[] args) {
        int total = 0;
        for (int i = 0; i < 4; i++) {
            if (i == 1)
                continue;
            total += i;
        }
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/foreach_array.
 */
class ControlForeachArray {

    static void runExample(String[] args) {
        int total = 0;
        for (int value : new int[] { 1, 2, 3 }) {
            if (value == 2)
                continue;
            total += value;
        }
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/foreach_list.
 */
class ControlForeachList {

    static void runExample(String[] args) {
        int total = 0;
        for (int value : java.util.List.of(2, 4, 6)) {
            total += value;
        }
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/infinite_for.
 */
class ControlInfiniteFor {

    static void runExample(String[] args) {
        int n = 0;
        for (; ; ) {
            n++;
            if (n == 3)
                break;
        }
        System.out.println(n);
    }
}

/**
 * Исполняемый пример: control_flow/nested.
 */
class ControlNested {

    static void runExample(String[] args) {
        int total = 0;
        for (int i = 0; i < 3; i++) {
            int j = 0;
            while (j < 3) {
                j++;
                if (j == 1)
                    continue;
                if (j == 3)
                    break;
                total += i + j;
            }
        }
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/return.
 */
class ControlReturn {

    static void runExample(String[] args) {
        int total = 0;
        for (int i = 0; i < 5; i++) {
            total += i;
            if (i == 2) {
                System.out.println(total);
                return;
            }
        }
        System.out.println(-1);
    }
}

/**
 * Исполняемый пример: control_flow/switch_arrow.
 */
class ControlSwitchArrow {

    static void runExample(String[] args) {
        int total = 0;
        int input = 2;
        switch(input) {
            case 1 ->
                {
                    total += 1;
                }
            case 2, 3 ->
                {
                    total += 4;
                }
            default ->
                {
                    total += 10;
                }
        }
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/switch_colon.
 */
class ControlSwitchColon {

    static void runExample(String[] args) {
        int total = 0;
        for (int i = 0; i < 3; i++) {
            switch(i) {
                case 0:
                    total += 1;
                case 1:
                    total += 2;
                    break;
                default:
                    continue;
            }
            total += 10;
        }
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/switch_empty_labels.
 */
class ControlSwitchEmptyLabels {

    static void runExample(String[] args) {
        int total = 0;
        int input = 1;
        switch(input) {
            case 1:
            case 2:
                total += 4;
                break;
            default:
        }
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/unbraced.
 */
class ControlUnbraced {

    static void runExample(String[] args) {
        int total = 0;
        for (int i = 1; i <= 3; i++) total += i;
        System.out.println(total);
    }
}

/**
 * Исполняемый пример: control_flow/while.
 */
class ControlWhile {

    static void runExample(String[] args) {
        int n = 0, total = 0;
        while (n < 4) {
            n++;
            if (n == 2)
                continue;
            total += n;
            if (total > 5)
                break;
        }
        System.out.println(total);
    }
}

/**
 * Небольшой склад: проверяемые ошибки и согласованное изменение остатка.
 */
interface ProductView {

    String name();

    int price();
}

class Product implements ProductView {

    private final String sku;

    private final String name;

    private final int price;

    Product(String sku, String name, int price) {
        if (price < 0) {
            throw new IllegalArgumentException("Отрицательная цена");
        }
        this.sku = sku;
        this.name = name;
        this.price = price;
    }

    String sku() {
        return sku;
    }

    public String name() {
        return name;
    }

    public int price() {
        return price;
    }
}

class StockProblem extends Exception {

    StockProblem(String message) {
        super(message);
    }
}

class Warehouse {

    private final Map<String, Product> products = new LinkedHashMap<>();

    private final Map<String, Integer> quantities = new LinkedHashMap<>();

    void register(Product product, int quantity) {
        if (quantity < 0 || products.containsKey(product.sku())) {
            throw new IllegalArgumentException("Недопустимый товар или остаток");
        }
        products.put(product.sku(), product);
        quantities.put(product.sku(), quantity);
    }

    Product product(String sku) throws StockProblem {
        Product product = products.get(sku);
        if (product == null) {
            throw new StockProblem("Неизвестный артикул: " + sku);
        }
        return product;
    }

    int available(String sku) throws StockProblem {
        product(sku);
        return quantities.get(sku);
    }

    void require(String sku, int quantity) throws StockProblem {
        if (quantity <= 0) {
            throw new StockProblem("Количество должно быть положительным");
        }
        if (available(sku) < quantity) {
            throw new StockProblem("Недостаточно товара: " + sku);
        }
    }

    void reserve(String sku, int quantity) throws StockProblem {
        require(sku, quantity);
        quantities.put(sku, quantities.get(sku) - quantity);
    }

    int units() {
        int total = 0;
        for (int quantity : quantities.values()) {
            total += quantity;
        }
        return total;
    }

    int inventoryValue() {
        int total = 0;
        for (String sku : products.keySet()) {
            total += products.get(sku).price() * quantities.get(sku);
        }
        return total;
    }

    List<String> lowStock(int threshold) {
        List<String> result = new ArrayList<>();
        for (String sku : quantities.keySet()) {
            if (quantities.get(sku) < threshold) {
                result.add(sku);
            }
        }
        Collections.sort(result);
        return result;
    }
}

class Cart {

    private final Map<String, Integer> lines = new LinkedHashMap<>();

    void add(String sku, int quantity) {
        if (quantity <= 0) {
            throw new IllegalArgumentException("Количество должно быть положительным");
        }
        lines.put(sku, lines.getOrDefault(sku, 0) + quantity);
    }

    void remove(String sku) {
        lines.remove(sku);
    }

    int size() {
        return lines.size();
    }

    int total(Warehouse warehouse) throws StockProblem {
        int subtotal = 0;
        for (Map.Entry<String, Integer> line : lines.entrySet()) {
            warehouse.require(line.getKey(), line.getValue());
            subtotal += warehouse.product(line.getKey()).price() * line.getValue();
        }
        return BlueprintDemo.calculateTotal(subtotal, 1);
    }

    int checkout(Warehouse warehouse) throws StockProblem {
        // Сначала проверяем весь заказ, затем изменяем склад. Потоки не используются.
        int result = total(warehouse);
        for (Map.Entry<String, Integer> line : lines.entrySet()) {
            warehouse.reserve(line.getKey(), line.getValue());
        }
        lines.clear();
        return result;
    }
}

class StockDemo {

    static Warehouse sample() {
        Warehouse warehouse = new Warehouse();
        warehouse.register(new Product("notebook", "Блокнот", 500), 10);
        warehouse.register(new Product("pen", "Ручка", 200), 20);
        warehouse.register(new Product("folder", "Папка", 100), 5);
        return warehouse;
    }

    static void runExample(String[] args) throws StockProblem {
        Warehouse warehouse = sample();
        Cart cart = new Cart();
        cart.add("notebook", 2);
        cart.add("pen", 2);
        System.out.println("Корзина: " + cart.checkout(warehouse));
        System.out.println("Остаток: " + warehouse.available("notebook"));
        System.out.println("Единиц: " + warehouse.units());
        System.out.println("Стоимость: " + warehouse.inventoryValue());
        System.out.println("Мало: " + warehouse.lowStock(6));
        try {
            warehouse.reserve("folder", 20);
        } catch (StockProblem error) {
            System.out.println("Отказ: " + error.getMessage());
        } finally {
            System.out.println("Папок: " + warehouse.available("folder"));
        }
    }
}
