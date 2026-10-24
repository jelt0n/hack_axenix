public class Coverage {
  static int calculate() {
    try { return 3; }
    finally {
      try { System.out.println("тело очистки"); }
      finally { System.out.println("вложенная очистка"); }
    }
  }
  public static void main(String[] args) { System.out.println(calculate()); }
}
