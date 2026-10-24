public class Coverage {
  static int calculate() {
    try {
      try { return 1; }
      finally { System.out.println("внутри"); }
    } finally { System.out.println("снаружи"); }
  }
  public static void main(String[] args) {
    System.out.println(calculate());
    for (int i = 0; i < 3; i++) {
      try {
        if (i == 0) continue;
        if (i == 1) break;
      } finally { System.out.println("шаг " + i); }
    }
  }
}
