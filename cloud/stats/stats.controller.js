const { ProductsModel } = require('../products/products.model');
const { ReturnsModel } = require('../returns/returns.model');

exports.StatsController = new class StatsCrontroller {
  constructor() {}

  getProductStats() {
    const products = () => ProductsModel.getProductsByFilters({
      limit: 1000000
    }).find();
    
    const getReturnedTotal = productId => ReturnsModel.getReturnsByFilters({
      equal: [
        { key: 'productId', value: productId },
        { key: 'returnTypeId', value: 0 }
      ]
    }).count();

    const getRepairedTotal = productId => ReturnsModel.getReturnsByFilters({
      equal: [
        { key: 'productId', value: productId },
        { key: 'returnTypeId', value: 1 }
      ]
    }).count();

    return products()
      .then(products => 
        Promise.all([...products.map(product => 
          Promise.all([getReturnedTotal(product.get('productId')), getRepairedTotal(product.get('productId'))])
            .then(results => this.createProductStatsObject(product, results[0], results[1]))
        )])
      );
  }

  createProductStatsObject(productObject, returnedTotal, repairedTotal) {
    return {
      productId: productObject.get('productId'),
      productName: productObject.get('name'),
      totalSold: productObject.get('total_sold'),
      unitsReturned: returnedTotal,
      unitsReturnedP: productObject.get('total_sold') !== 0 ? (returnedTotal * 100) / productObject.get('total_sold') : 0,
      unitsRepaired: repairedTotal,
      unitsRepairedP: repairedTotal !== 0 ? (repairedTotal * 100) / productObject.get('total_sold') : 0,
      totalReveneu: productObject.get('price') * productObject.get('total_sold')
    };
  }

}