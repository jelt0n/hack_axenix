public class Flow {
  public static void main(String[] args) {
    int total = 0;
    for (int i = 0; i < 5; i++) {
      total += i;
      if (i == 2) { System.out.println(total); return; }
    }
    System.out.println(-1);
  }
}
