class Problem extends Exception { Problem(String message) { super(message); } }
public class Coverage {
  static int calculate(int value) throws Problem {
    if (value < 0) throw new Problem("отрицательное");
    return value;
  }
  public static void main(String[] args) {
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
