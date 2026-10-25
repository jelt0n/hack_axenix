import java.util.*;
public class Coverage {
    public static void main(String[] args) {
        int count = 0;
        try {
            Collections.emptyIterator().next();
        } catch (NoSuchElementException error) {
            System.out.println("Нет элемента");
            count++;
        }
        try {
            new Scanner("текст").nextInt();
        } catch (InputMismatchException error) {
            System.out.println("Ожидалось число");
            count++;
        }
        count += 0;
        System.out.println("Перехвачено: " + count);
    }
}
