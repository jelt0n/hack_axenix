export const exampleSource = `package demo;

/** Небольшой пример: скидка зависит от суммы заказа. */
public class OrderCalculator {
    private static final int DISCOUNT_THRESHOLD = 1000;

    public int calculateTotal(int amount, int quantity) {
        int subtotal = amount * quantity;
        if (subtotal >= DISCOUNT_THRESHOLD) {
            int discount = subtotal / 10;
            return subtotal - discount;
        } else {
            return subtotal;
        }
    }

    public static void main(String[] args) {
        OrderCalculator calculator = new OrderCalculator();
        int total = calculator.calculateTotal(250, 5);
        System.out.println("Итого: " + total);
    }
}
`;
