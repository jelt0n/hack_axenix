public class Flow {
  public static void main(String[] args) {
    int total = 0;
    for (int i = 0; i < 3; i++) {
      int j = 0;
      while (j < 3) {
        j++;
        if (j == 1) continue;
        if (j == 3) break;
        total += i + j;
      }
    }
    System.out.println(total);
  }
}
