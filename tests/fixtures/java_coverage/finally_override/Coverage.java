public class Coverage {
  static int calculate() {
    try { return 1; }
    finally { return 2; }
  }
  public static void main(String[] args) {
    int value = calculate();
    System.out.println(value);
  }
}
