class Broken extends RuntimeException { Broken(String message) { super(message); } }
public class Coverage {
  public static void main(String[] args) {
    int value = 1;
    try {
      throw new Broken("сбой " + value);
    } finally {
      System.out.println("Очистка");
    }
  }
}
