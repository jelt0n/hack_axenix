import java.nio.charset.StandardCharsets;
import java.util.Formatter;
import java.util.Locale;
import java.util.Scanner;
public class Coverage {
  public static void main(String[] args) {
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
