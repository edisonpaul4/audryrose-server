const { ProductsModel } = require('../products/products.model');

exports.StatsController = new class StatsCrontroller {
  constructor() {}

  getProductStats() {
    const products = () => ProductsModel.getProductsByFilters({
      limit: 1000000
    }).find();

    return products()
      .then(products => products.map(this.createProductStatsObject));
  }

  createProductStatsObject(productObject) {
    const unitsReturned = typeof productObject.get('totalReturned') !== 'undefined' ? productObject.get('totalReturned') : 0;
    const unitsRepaired = typeof productObject.get('totalRepaired') !== 'undefined' ? productObject.get('totalRepaired') : 0;
    return {
      productId: productObject.get('productId'),
      productName: productObject.get('name'),
      totalSold: productObject.get('total_sold'),
      unitsReturned,
      unitsReturnedP: productObject.get('total_sold') !== 0 ? (unitsReturned * 100) / productObject.get('total_sold') : 0,
      unitsRepaired,
      unitsRepairedP: productObject.get('total_sold') !== 0 ? (unitsRepaired * 100) / productObject.get('total_sold') : 0,
      totalReveneu: productObject.get('price') * productObject.get('total_sold')
    };
  }

}